import { Account, Asset, Claimant, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { buildClaimTx, buildSendTx, explain, formatUtc, mismatches } from "../src";
import { ALICE, ISSUER, MARIA, NOW, NOW_SEC, STRANGER, aliceAccount, config } from "./fixtures";

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
