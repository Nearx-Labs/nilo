import { Account, Address, Memo, Operation, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  type AgentConfig,
  VENUE_AAVE_ARBITRUM,
  VENUE_XOXNO,
  allowanceFor,
  explainAgent,
  mandateFrom,
  mandateMismatches,
  mandateToScVal,
  personality,
  split,
} from "../src";
import { ALICE, NOW_SEC, SPONSOR, STRANGER, config } from "./fixtures";

const agent: AgentConfig = {
  contract: "CC4VU642T2Z4IEGANZV4HUIEQDOWP2YONA6AFX53WUHNYGZ5VZTZQTR7",
  operator: SPONSOR,
  usdcContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  xoxnoController: "CCXRWJ6SIU2WPFEGLFGJVITPL57QAYIMIO6OAM2NBGNDQSSCK2FFV3F3",
  rpcUrl: "https://soroban-testnet.stellar.org",
  venues: [VENUE_XOXNO],
};
const OTHER_CONTRACT = "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP";

const addr = (a: string) => new Address(a).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });

const fn = (contract: string, name: string, args: xdr.ScVal[]) =>
  xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: name, args }),
  );
const invocation = (contract: string, name: string, args: xdr.ScVal[], subs: xdr.SorobanAuthorizedInvocation[] = []) =>
  new xdr.SorobanAuthorizedInvocation({ function: fn(contract, name, args), subInvocations: subs });
const sourceAuth = (root: xdr.SorobanAuthorizedInvocation) =>
  new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: root });

function craft(
  name: string,
  args: xdr.ScVal[],
  auth: xdr.SorobanAuthorizationEntry[],
  opts: { source?: string; contract?: string; memo?: boolean; fee?: string } = {},
): string {
  const contract = opts.contract ?? agent.contract;
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: name, args }),
  );
  return new TransactionBuilder(new Account(opts.source ?? ALICE, "1"), {
    fee: opts.fee ?? "1000000",
    networkPassphrase: config.networkPassphrase,
    timebounds: { minTime: 0, maxTime: NOW_SEC + 120 },
    memo: opts.memo ? Memo.text("hi") : undefined,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .build()
    .toXDR();
}

const mandate = mandateFrom(personality("guardian")!, NOW_SEC, 30, agent.venues);
const { amount: allowance, ledger } = allowanceFor(mandate, NOW_SEC, 1_000_000);
const mandateArgs = [addr(ALICE), mandateToScVal(mandate), i128(allowance), u32(ledger)];
const approve = (spender = agent.contract, amount = allowance, until = ledger) =>
  invocation(agent.usdcContract, "approve", [addr(ALICE), addr(spender), i128(amount), u32(until)]);
const mandateTx = (subs = [approve()], args = mandateArgs, opts = {}) =>
  craft("set_mandate", args, [sourceAuth(invocation(agent.contract, "set_mandate", args, subs))], opts);

describe("explainAgent: set_mandate", () => {
  const e = explainAgent(mandateTx(), config, agent);

  it("recognizes the mandate the app builds", () => {
    expect(e.kind).toBe("agent");
    expect(mandateMismatches(e, ALICE, mandate, allowance)).toEqual([]);
  });

  it("states the cap, venue, total allowance, expiry and that withdrawals pay the user", () => {
    const text = e.lines.join("\n");
    expect(text).toContain("up to 50 USDC of your USDC per week into XOXNO Lending on Stellar");
    expect(text).toContain("at most 250 USDC in total");
    expect(text).toContain(`Withdrawals always pay your own account ${ALICE}`);
    expect(text).toContain("Personality: Guardian");
  });

  it("flags a mandate that differs from what was asked", () => {
    const other = { ...mandate, limit: mandate.limit * 2n };
    expect(mandateMismatches(e, ALICE, other, allowance)).toEqual(["limit"]);
  });

  const rejects = (label: string, xdrB64: string) =>
    it(`rejects ${label}`, () => expect(explainAgent(xdrB64, config, agent).kind).toBe("unrecognized"));

  rejects("a call to another contract", mandateTx([approve()], mandateArgs, { contract: OTHER_CONTRACT }));
  rejects("a mandate for someone else", mandateTx([approve()], [addr(STRANGER), ...mandateArgs.slice(1)]));
  rejects("an approval to another spender", mandateTx([approve(STRANGER)]));
  rejects("an approval bigger than the mandate's allowance", mandateTx([approve(agent.contract, allowance * 10n)]));
  rejects("an extra authorized call", mandateTx([approve(), invocation(agent.usdcContract, "transfer", [addr(ALICE), addr(STRANGER), i128(1n)])]));
  rejects("a missing approval", mandateTx([]));
  rejects("a fee above 5 XLM", mandateTx([approve()], mandateArgs, { fee: "60000000" }));
  rejects("a venue Nilo doesn't run", (() => {
    const both = { ...mandate, venues: VENUE_XOXNO | VENUE_AAVE_ARBITRUM };
    const args = [addr(ALICE), mandateToScVal(both), i128(allowance), u32(ledger)];
    return mandateTx([approve()], args);
  })());
  rejects("an authorization signed by another address", (() => {
    const cred = xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: new Address(STRANGER).toScAddress(), nonce: xdr.Int64.fromString("1"), signatureExpirationLedger: 1, signature: xdr.ScVal.scvVoid() }),
    );
    const entry = new xdr.SorobanAuthorizationEntry({ credentials: cred, rootInvocation: invocation(agent.contract, "set_mandate", mandateArgs, [approve()]) });
    return craft("set_mandate", mandateArgs, [entry]);
  })());
});

describe("explainAgent: revoke, withdraw, invest", () => {
  const revokeArgs = [addr(ALICE)];
  const zeroApprove = invocation(agent.usdcContract, "approve", [addr(ALICE), addr(agent.contract), i128(0n), u32(0)]);

  it("explains a revoke that zeroes the allowance", () => {
    const e = explainAgent(craft("revoke", revokeArgs, [sourceAuth(invocation(agent.contract, "revoke", revokeArgs, [zeroApprove]))]), config, agent);
    expect(e.kind).toBe("agent");
    expect(e.lines[0]).toContain("can no longer invest");
  });

  it("explains a withdrawal of everything to the signer", () => {
    const args = [addr(ALICE), addr(ALICE), i128(0n)];
    const e = explainAgent(craft("withdraw", args, [sourceAuth(invocation(agent.contract, "withdraw", args))]), config, agent);
    expect(e.kind).toBe("agent");
    expect(e.lines[0]).toContain(`Withdraws all your USDC from XOXNO Lending, interest included, to your account ${ALICE}`);
  });

  it("rejects a withdrawal for another account", () => {
    const args = [addr(ALICE), addr(STRANGER), i128(0n)];
    expect(explainAgent(craft("withdraw", args, [sourceAuth(invocation(agent.contract, "withdraw", args))]), config, agent).kind).toBe("unrecognized");
  });

  it("only accepts invest from Nilo's operator", () => {
    const args = [addr(ALICE), u32(VENUE_XOXNO), i128(20_000_000n)];
    const auth = [sourceAuth(invocation(agent.contract, "invest", args))];
    expect(explainAgent(craft("invest", args, auth, { source: SPONSOR }), config, agent).kind).toBe("agent");
    expect(explainAgent(craft("invest", args, auth), config, agent).kind).toBe("unrecognized");
  });
});

describe("split", () => {
  it("follows the personality's weights over the allowed venues", () => {
    const legs = split(100_000_000n, personality("balanced")!, VENUE_XOXNO | VENUE_AAVE_ARBITRUM);
    expect(legs).toEqual([
      { venue: VENUE_XOXNO, amount: 60_000_000n },
      { venue: VENUE_AAVE_ARBITRUM, amount: 40_000_000n },
    ]);
  });

  it("gives a disallowed venue's share to the first allowed one", () => {
    expect(split(100_000_000n, personality("balanced")!, VENUE_XOXNO)).toEqual([{ venue: VENUE_XOXNO, amount: 100_000_000n }]);
  });

  it("rounds the CCTP leg to whole 6-decimal units and keeps the total", () => {
    const legs = split(10_000_003n, personality("explorer")!, VENUE_XOXNO | VENUE_AAVE_ARBITRUM);
    expect(legs.reduce((s, l) => s + l.amount, 0n)).toBe(10_000_003n);
    expect(legs.find((l) => l.venue === VENUE_AAVE_ARBITRUM)!.amount % 10n).toBe(0n);
  });
});
