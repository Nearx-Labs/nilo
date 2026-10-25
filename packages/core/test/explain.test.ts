import { Account, Asset, Claimant, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { buildClaimTx, buildSendTx, buildSponsoredClaimTx, explain, formatUtc, mismatches } from "../src";
import { ALICE, ISSUER, MARIA, NOW, NOW_SEC, SPONSOR, STRANGER, aliceAccount, config } from "./fixtures";

const TESTUSD = { code: "TESTUSD", issuer: ISSUER };
const intent = { amount: "50", asset: TESTUSD, recipient: MARIA, recipientName: "maria", deadlineSeconds: 120 };
const deadline = NOW_SEC + 120;

function craft(
  claimants: Claimant[],
  opts: { extraOp?: boolean; memo?: boolean; source?: string } = {},
): string {
  const b = new TransactionBuilder(new Account(opts.source ?? ALICE, "1"), {
    fee: "100",
    networkPassphrase: config.networkPassphrase,
    timebounds: { minTime: 0, maxTime: NOW_SEC + 180 },
    memo: opts.memo ? Memo.text("hi") : undefined,
  }).addOperation(
    Operation.createClaimableBalance({ asset: new Asset("TESTUSD", ISSUER), amount: "50", claimants }),
  );
  if (opts.extraOp) b.addOperation(Operation.payment({ destination: STRANGER, asset: Asset.native(), amount: "1" }));
  return b.build().toXDR();
}
const before = (t: number) => Claimant.predicateBeforeAbsoluteTime(String(t));
const after = (t: number) => Claimant.predicateNot(before(t));

describe("explain: send", () => {
  const { xdr } = buildSendTx(intent, aliceAccount(), config, NOW);
  const e = explain(xdr, config);

  it("recognizes the transaction the builder made", () => {
    expect(e.kind).toBe("send");
  });

  it("states amount, full issuer, full recipient and deadline", () => {
    const text = e.lines.join("\n");
    expect(text).toContain("Sends 50 TESTUSD");
    expect(text).toContain(ISSUER);
    expect(text).toContain(MARIA);
    expect(text).toContain('"maria"');
    expect(text).toContain(formatUtc(deadline));
    expect(text).toContain(`only you (${ALICE}) can recover`);
  });

  it("agrees with the validated intent", () => {
    expect(mismatches(e, intent, ALICE, deadline)).toEqual([]);
    expect(mismatches(e, { ...intent, amount: "500" }, ALICE, deadline)).toEqual(["amount"]);
    expect(mismatches(e, { ...intent, recipient: STRANGER }, ALICE, deadline)).toEqual(["recipient"]);
  });
});

describe("explain: tampered transactions are unrecognized", () => {
  const cases: Record<string, string> = {
    "swapped predicates": craft([new Claimant(MARIA, after(deadline)), new Claimant(ALICE, before(deadline))]),
    "third claimant": craft([
      new Claimant(MARIA, before(deadline)),
      new Claimant(ALICE, after(deadline)),
      new Claimant(STRANGER, Claimant.predicateUnconditional()),
    ]),
    "reclaim goes to a stranger": craft([new Claimant(MARIA, before(deadline)), new Claimant(STRANGER, after(deadline))]),
    "different deadlines": craft([new Claimant(MARIA, before(deadline)), new Claimant(ALICE, after(deadline + 3600))]),
    "unconditional recipient": craft([
      new Claimant(MARIA, Claimant.predicateUnconditional()),
      new Claimant(ALICE, after(deadline)),
    ]),
    "extra operation": craft([new Claimant(MARIA, before(deadline)), new Claimant(ALICE, after(deadline))], {
      extraOp: true,
    }),
    memo: craft([new Claimant(MARIA, before(deadline)), new Claimant(ALICE, after(deadline))], { memo: true }),
    garbage: "AAAA not xdr",
  };
  for (const [name, xdr] of Object.entries(cases)) {
    it(name, () => {
      const e = explain(xdr, config);
      expect(e.kind).toBe("unrecognized");
      expect(e.lines.join("\n")).toContain("Do not sign");
    });
  }
});

describe("explain: claim", () => {
  const balanceId = "00000000" + "ab".repeat(32);

  it("explains trustline + claim", () => {
    const e = explain(buildClaimTx(balanceId, new Account(MARIA, "1"), config, TESTUSD, NOW), config);
    expect(e.kind).toBe("claim");
    const text = e.lines.join("\n");
    expect(text).toContain("Adds a trustline");
    expect(text).toContain(ISSUER);
    expect(text).toContain(balanceId);
  });

  it("explains a plain recovery", () => {
    const e = explain(buildClaimTx(balanceId, aliceAccount(), config, undefined, NOW), config);
    expect(e.kind).toBe("claim");
    expect(e.lines.join("\n")).not.toContain("trustline");
  });

  it("rejects a changeTrust that removes a trustline (limit 0)", () => {
    const xdr = new TransactionBuilder(new Account(MARIA, "1"), {
      fee: "100",
      networkPassphrase: config.networkPassphrase,
      timebounds: { minTime: 0, maxTime: NOW_SEC + 180 },
    })
      .addOperation(Operation.changeTrust({ asset: new Asset("TESTUSD", ISSUER), limit: "0" }))
      .addOperation(Operation.claimClaimableBalance({ balanceId }))
      .build()
      .toXDR();
    expect(explain(xdr, config).kind).toBe("unrecognized");
  });
});

describe("explain: sponsored claim", () => {
  const balanceId = "00000000" + "ab".repeat(32);
  const sponsor = () => new Account(SPONSOR, "7");

  function sponsoredTx(ops: (b: TransactionBuilder) => TransactionBuilder, source = SPONSOR): string {
    const b = new TransactionBuilder(new Account(source, "7"), {
      fee: "100",
      networkPassphrase: config.networkPassphrase,
      timebounds: { minTime: 0, maxTime: NOW_SEC + 180 },
    });
    return ops(b).build().toXDR();
  }
  const begin = (id = MARIA) => Operation.beginSponsoringFutureReserves({ sponsoredId: id });
  const trust = (limit?: string, source = MARIA) =>
    Operation.changeTrust({ asset: new Asset("TESTUSD", ISSUER), limit, source });
  const end = (source = MARIA) => Operation.endSponsoringFutureReserves({ source });
  const claim = (source = MARIA) => Operation.claimClaimableBalance({ balanceId, source });

  it("explains sponsored trustline + claim", () => {
    const e = explain(buildSponsoredClaimTx(balanceId, sponsor(), MARIA, config, TESTUSD, NOW), config);
    expect(e.kind).toBe("claim");
    if (e.kind !== "claim") return;
    expect(e.fields).toMatchObject({ source: SPONSOR, claimant: MARIA, sponsored: true, trustline: TESTUSD, balanceId });
    const text = e.lines.join("\n");
    expect(text).toContain(`into your account ${MARIA}`);
    expect(text).toContain("pays the network fee and the 0.5 XLM trustline reserve");
  });

  it("explains a sponsored claim without trustline", () => {
    const e = explain(buildSponsoredClaimTx(balanceId, sponsor(), MARIA, config, undefined, NOW), config);
    expect(e.kind).toBe("claim");
    if (e.kind !== "claim") return;
    expect(e.fields).toMatchObject({ claimant: MARIA, sponsored: true, trustline: undefined });
    expect(e.lines.join("\n")).toContain("pays the network fee.");
  });

  it("marks a self-paid claim as not sponsored", () => {
    const e = explain(buildClaimTx(balanceId, new Account(MARIA, "1"), config, TESTUSD, NOW), config);
    expect(e.kind === "claim" && e.fields).toMatchObject({ claimant: MARIA, sponsored: false });
  });

  const tampered: Record<string, string> = {
    "unknown sponsor": sponsoredTx((b) => b.addOperation(begin()).addOperation(trust()).addOperation(end()).addOperation(claim()), STRANGER),
    "trustline with no claim": sponsoredTx((b) => b.addOperation(begin()).addOperation(trust()).addOperation(end())),
    "sponsors a different account": sponsoredTx((b) =>
      b.addOperation(begin(STRANGER)).addOperation(trust()).addOperation(end()).addOperation(claim()),
    ),
    "trustline on a different account": sponsoredTx((b) =>
      b.addOperation(begin()).addOperation(trust(undefined, STRANGER)).addOperation(end()).addOperation(claim()),
    ),
    "extra payment from the claimant": sponsoredTx((b) =>
      b
        .addOperation(begin())
        .addOperation(trust())
        .addOperation(end())
        .addOperation(Operation.payment({ destination: SPONSOR, asset: Asset.native(), amount: "1", source: MARIA }))
        .addOperation(claim()),
    ),
    "end before changeTrust": sponsoredTx((b) => b.addOperation(begin()).addOperation(end()).addOperation(trust()).addOperation(claim())),
    "trustline limit 0": sponsoredTx((b) => b.addOperation(begin()).addOperation(trust("0")).addOperation(end()).addOperation(claim())),
    "sponsor claims for itself": sponsoredTx((b) => b.addOperation(Operation.claimClaimableBalance({ balanceId }))),
    "send from the sponsor": sponsoredTx((b) =>
      b.addOperation(
        Operation.createClaimableBalance({
          asset: new Asset("TESTUSD", ISSUER),
          amount: "50",
          claimants: [new Claimant(MARIA, before(deadline)), new Claimant(SPONSOR, after(deadline))],
        }),
      ),
    ),
  };
  for (const [name, xdr] of Object.entries(tampered)) {
    it(`rejects: ${name}`, () => {
      const e = explain(xdr, config);
      expect(e.kind).toBe("unrecognized");
      expect(e.lines.join("\n")).toContain("Do not sign");
    });
  }
});
