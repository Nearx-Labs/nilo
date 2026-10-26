// Fixed-template explanations for NiloAgent contract calls, read only from the
// XDR. Like explain(), anything that is not exactly a call this app builds is
// reported as unrecognized: wrong contract, wrong function, arguments that act
// for someone else, or authorizations beyond the one USDC approval expected.
import { FeeBumpTransaction, TransactionBuilder, scValToNative } from "@stellar/stellar-sdk";
import { type AgentConfig, type Mandate, VENUES, type VenueId, mandateFromNative, personality, stroopsToUsdc } from "./agent";
import { type AppConfig, fromStroops } from "./config";
import { formatUtc } from "./explain";

export type AgentAction = "set_mandate" | "revoke" | "withdraw" | "invest";

export interface AgentFields {
  action: AgentAction;
  /** Who signs and pays the fee: the user, or Nilo's operator for `invest`. */
  source: string;
  /** Whose money the call is about. */
  user: string;
  mandate?: Mandate;
  /** USDC the agent may draw in total (set_mandate). */
  allowance?: bigint;
  allowanceLedger?: number;
  /** Stroops; 0 on withdraw means everything. */
  amount?: bigint;
  /** Most Circle's forwarder may keep on a cross-chain invest, in stroops. */
  bridgeFee?: bigint;
  venue?: VenueId;
  fee: string;
}

export type AgentExplanation =
  | { kind: "agent"; fields: AgentFields; lines: string[] }
  | { kind: "unrecognized"; reason: string; lines: string[] };

/** Most XLM a NiloAgent call may spend on fees before we call it suspicious. */
const MAX_FEE_STROOPS = 50_000_000n;

function unrecognized(reason: string): AgentExplanation {
  return { kind: "unrecognized", reason, lines: ["This transaction does not match anything this app builds.", `Reason: ${reason}`, "Do not sign it."] };
}

// stellar-sdk 17 decodes XDR into plain unions ({ type, invokeContract }) whose JSON form is canonical.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type X = any;
const native = (v: X) => scValToNative(v) as unknown;
const json = (v: X) => JSON.stringify(v);
/** Strkey of a decoded ScAddress, or the text of a decoded XdrString. */
const text = (v: X): string => {
  const j = JSON.parse(json(v));
  return typeof j === "string" ? j : String(v);
};
const usdc = (stroops: bigint) => `${fromStroops(stroops)} USDC`;
const venueNames = (bits: number) =>
  (Object.keys(VENUES).map(Number) as VenueId[])
    .filter((v) => bits & v)
    .map((v) => `${VENUES[v].name} on ${VENUES[v].place}`)
    .join(" and ");

function period(seconds: number): string {
  if (seconds % 604_800 === 0) return seconds === 604_800 ? "week" : `${seconds / 604_800} weeks`;
  if (seconds % 86_400 === 0) return seconds === 86_400 ? "day" : `${seconds / 86_400} days`;
  return `${seconds} seconds`;
}

interface Call {
  contract: string;
  fn: string;
  args: X[];
}

const toCall = (c: X): Call => ({ contract: text(c.contractAddress), fn: text(c.functionName), args: c.args });

function contractCall(inv: X): Call | null {
  if (inv.function.type !== "sorobanAuthorizedFunctionTypeContractFn") return null;
  return toCall(inv.function.contractFn);
}

const sameArgs = (a: X[], b: X[]) => a.length === b.length && a.every((v, i) => json(v) === json(b[i]));

/**
 * Checks the auth entries: exactly one, signed by the transaction source, whose
 * root is this very call and whose only sub-invocation (if `approve` is given)
 * is the USDC approval to the agent contract with the expected arguments.
 */
function checkAuth(entries: X[], call: Call, approve?: { args: unknown[] }, usdcContract?: string): string | null {
  if (entries.length !== 1) return `it carries ${entries.length} authorizations instead of 1.`;
  const entry = entries[0];
  if (entry.credentials.type !== "sorobanCredentialsSourceAccount") {
    return "an authorization is signed for an account other than the one paying.";
  }
  const root = contractCall(entry.rootInvocation);
  if (!root || root.contract !== call.contract || root.fn !== call.fn || !sameArgs(root.args, call.args)) {
    return "the authorization does not match the call.";
  }
  const subs: X[] = entry.rootInvocation.subInvocations;
  if (!approve) return subs.length === 0 ? null : "it authorizes extra contract calls.";
  if (subs.length !== 1 || subs[0].subInvocations.length !== 0) return "it authorizes extra contract calls.";
  const sub = contractCall(subs[0]);
  if (!sub || sub.contract !== usdcContract || sub.fn !== "approve") return "it authorizes a call other than the USDC approval.";
  const got = sub.args.map(native).map(String);
  const want = approve.args.map(String);
  if (got.length !== want.length || got.some((g, i) => g !== want[i])) return "the USDC approval does not match the mandate.";
  return null;
}

export function explainAgent(xdrBase64: string, config: AppConfig, agent: AgentConfig): AgentExplanation {
  let tx;
  try {
    tx = TransactionBuilder.fromXDR(xdrBase64, config.networkPassphrase);
  } catch (e) {
    return unrecognized(`the XDR could not be decoded (${(e as Error).message}).`);
  }
  if (tx instanceof FeeBumpTransaction) return unrecognized("it is a fee-bump transaction.");
  if (tx.memo.type !== "none") return unrecognized("it carries a memo.");
  if (tx.operations.length !== 1 || tx.operations[0].type !== "invokeHostFunction") {
    return unrecognized(`unexpected operations: ${tx.operations.map((o) => o.type).join(", ")}.`);
  }
  const op = tx.operations[0];
  if (op.source && op.source !== tx.source) return unrecognized("the operation acts on behalf of a different account.");
  if (BigInt(tx.fee) > MAX_FEE_STROOPS) return unrecognized(`its fee of ${fromStroops(BigInt(tx.fee))} XLM is above ${fromStroops(MAX_FEE_STROOPS)} XLM.`);
  const func: X = op.func;
  if (func.type !== "hostFunctionTypeInvokeContract") return unrecognized("it deploys or uploads a contract.");
  const call = toCall(func.invokeContract);
  if (call.contract !== agent.contract) return unrecognized(`it calls contract ${call.contract}, not Nilo's agent.`);

  const fee = fromStroops(BigInt(tx.fee));
  const validUntil = tx.timeBounds && tx.timeBounds.maxTime !== "0" ? Number(tx.timeBounds.maxTime) : undefined;
  const footer = [
    `Network: ${config.networkPassphrase}.`,
    `Maximum network fee: ${fee} XLM.`,
    validUntil ? `This transaction can only be submitted before ${formatUtc(validUntil)}.` : "This transaction never expires.",
  ];
  const a = call.args.map(native);
  const auth: X[] = op.auth ?? [];

  switch (call.fn) {
    case "set_mandate": {
      if (a.length !== 4) return unrecognized("set_mandate has unexpected arguments.");
      const [user, raw, allowance, ledger] = a as [string, Record<string, unknown>, bigint, number];
      if (user !== tx.source) return unrecognized("the mandate is for a different account than the one signing.");
      const mandate = mandateFromNative(raw);
      const problem = checkAuth(auth, call, { args: [user, agent.contract, allowance, ledger] }, agent.usdcContract);
      if (problem) return unrecognized(problem);
      if (mandate.venues & ~agent.venues.reduce((b, v) => b | v, 0)) return unrecognized("the mandate allows a venue Nilo doesn't use.");
      const p = personality(mandate.profile);
      return {
        kind: "agent",
        fields: { action: "set_mandate", source: tx.source, user, mandate, allowance: BigInt(allowance), allowanceLedger: Number(ledger), fee },
        lines: [
          `Lets Nilo's agent invest up to ${usdc(mandate.limit)} of your USDC per ${period(mandate.period)} into ${venueNames(mandate.venues)}.`,
          `The agent can draw at most ${usdc(BigInt(allowance))} in total and can only invest until ${formatUtc(mandate.expiresAt)}.`,
          `Withdrawals always pay your own account ${user}; the agent cannot send your USDC anywhere else.`,
          ...(mandate.evmRecipient
            ? [
                `Cross-chain moves can only go to your own wallet ${mandate.evmRecipient} on ${agent.destination.name}, through Circle CCTP. Circle keeps up to ${agent.maxBridgeFee} USDC per move to pay the gas there.`,
              ]
            : []),
          `Personality: ${p ? p.name : mandate.profile}. You can revoke this at any time.`,
          ...footer,
        ],
      };
    }
    case "revoke": {
      const [user] = a as [string];
      if (a.length !== 1 || user !== tx.source) return unrecognized("the revoke is for a different account than the one signing.");
      const problem = checkAuth(auth, call, { args: [user, agent.contract, 0n, 0] }, agent.usdcContract);
      if (problem) return unrecognized(problem);
      return {
        kind: "agent",
        fields: { action: "revoke", source: tx.source, user, fee },
        lines: [
          "Ends your mandate: Nilo's agent can no longer invest your USDC, and its USDC allowance becomes 0.",
          "What is already invested stays yours and you can withdraw it at any time.",
          ...footer,
        ],
      };
    }
    case "withdraw": {
      const [caller, user, amount] = a as [string, string, bigint];
      if (a.length !== 3 || caller !== tx.source || user !== tx.source) return unrecognized("the withdrawal is for a different account than the one signing.");
      const problem = checkAuth(auth, call);
      if (problem) return unrecognized(problem);
      return {
        kind: "agent",
        fields: { action: "withdraw", source: tx.source, user, amount: BigInt(amount), fee },
        lines: [
          BigInt(amount) === 0n
            ? `Withdraws all your USDC from XOXNO Lending, interest included, to your account ${user}.`
            : `Withdraws ${usdc(BigInt(amount))} from XOXNO Lending to your account ${user}.`,
          ...footer,
        ],
      };
    }
    case "invest": {
      const [user, venue, amount, maxFee] = a as [string, number, bigint, bigint];
      if (a.length !== 4 || tx.source !== agent.operator) return unrecognized("only Nilo's operator invests through the agent.");
      if (!(Number(venue) in VENUES)) return unrecognized(`unknown venue ${venue}.`);
      const v = Number(venue) as VenueId;
      return {
        kind: "agent",
        fields: { action: "invest", source: tx.source, user, venue: v, amount: BigInt(amount), bridgeFee: BigInt(maxFee), fee },
        lines: [
          `Nilo's agent invests ${stroopsToUsdc(BigInt(amount))} USDC of ${user} into ${VENUES[v].name} on ${VENUES[v].place}, as their mandate allows.`,
          ...(BigInt(maxFee) > 0n ? [`Circle may keep up to ${stroopsToUsdc(BigInt(maxFee))} USDC of it to pay the gas on ${agent.destination.name}.`] : []),
          "The contract checks the mandate's limit, venues and expiry before moving anything.",
          ...footer,
        ],
      };
    }
    default:
      return unrecognized(`it calls ${call.fn}, which users never sign.`);
  }
}

/** Compares a decoded mandate with the one the app asked the user to sign. */
export function mandateMismatches(expl: AgentExplanation, user: string, expected: Mandate, allowance: bigint): string[] {
  if (expl.kind !== "agent" || expl.fields.action !== "set_mandate") return ["the transaction is not a mandate."];
  const f = expl.fields;
  const m = f.mandate!;
  const out: string[] = [];
  if (f.user !== user) out.push("account");
  if (m.limit !== expected.limit) out.push("limit");
  if (m.period !== expected.period) out.push("period");
  if (m.expiresAt !== expected.expiresAt) out.push("expiry");
  if (m.venues !== expected.venues) out.push("venues");
  if (m.profile !== expected.profile) out.push("personality");
  if ((m.evmRecipient ?? "") !== (expected.evmRecipient ?? "").toLowerCase()) out.push("destination wallet");
  if (f.allowance !== allowance) out.push("allowance");
  return out;
}
