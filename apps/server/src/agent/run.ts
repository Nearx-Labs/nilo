// The agent itself: for each user with a mandate, invest their idle USDC the way
// their personality says. Every move goes through the NiloAgent contract, which
// re-checks the mandate; this code only decides how much and where.
import { Horizon, Keypair } from "@stellar/stellar-sdk";
import {
  type Mandate,
  TESTNET_AGENT,
  VENUE_CROSSCHAIN,
  VENUES,
  agentCalls,
  defaultConfig,
  mandateFromNative,
  personality,
  split,
  stroopsToUsdc,
  toStroops,
  usdcToStroops,
} from "@nilo/core";
import { bridgeFee, waitForForward } from "./cctp";
import { invoke, read } from "./soroban";
import { type Activity, addUser, log, pendingForwards, setPending, users } from "./store";

const calls = agentCalls(TESTNET_AGENT);
const horizon = new Horizon.Server(defaultConfig.horizonUrl);
const USDC = defaultConfig.assets.find((a) => a.code === "USDC" && a.issuer)!;
/** Below this the agent doesn't bother: fees would eat the yield. */
const MIN_INVEST = usdcToStroops(1);
const reachable = TESTNET_AGENT.venues.reduce((bits, v) => bits | v, 0);

export class AgentError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503 = 400) {
    super(message);
  }
}

let operatorKey: Keypair | null = null;
export function operator(): Keypair {
  if (operatorKey) return operatorKey;
  const secret = process.env.NILO_OPERATOR_SECRET?.trim();
  if (!secret) throw new AgentError("The agent is not configured on this server (NILO_OPERATOR_SECRET).", 503);
  operatorKey = Keypair.fromSecret(secret);
  if (operatorKey.publicKey() !== TESTNET_AGENT.operator) {
    throw new AgentError("NILO_OPERATOR_SECRET is not the operator the agent contract trusts.", 503);
  }
  return operatorKey;
}

export async function mandateOf(user: string): Promise<Mandate | null> {
  const raw = await read<Record<string, unknown> | null>(calls.mandate(user));
  return raw ? mandateFromNative(raw) : null;
}

export async function walletUsdc(user: string): Promise<bigint> {
  const account = await horizon.loadAccount(user).catch(() => null);
  const line = account?.balances.find((b) => "asset_code" in b && b.asset_code === USDC.code && b.asset_issuer === USDC.issuer);
  return line ? toStroops(line.balance) : 0n;
}

// NiloAgent's error codes (contracts/soroban/nilo-agent/src/lib.rs).
const AGENT_ERRORS: Record<string, string> = {
  "1": "there is no active mandate.",
  "2": "the mandate has expired.",
  "3": "the mandate doesn't allow that venue.",
  "4": "this week's limit is already used.",
};

function investFailure(e: unknown): string {
  const message = String((e as Error)?.message ?? e);
  const code = message.match(/Error\(Contract, #(\d+)\)/)?.[1];
  if (code && message.includes("invest") && AGENT_ERRORS[code]) return AGENT_ERRORS[code];
  if (/allowance/i.test(message)) return "the mandate's allowance is used up. Sign a new mandate to continue.";
  if (/balance/i.test(message)) return "the wallet no longer had that much USDC.";
  return "the network refused the transaction.";
}

const running = new Set<string>();

/** Runs the agent once for one user and returns what it did. */
export async function runFor(user: string, trigger: NonNullable<Activity["trigger"]>): Promise<Activity[]> {
  if (running.has(user)) throw new AgentError("The agent is already working on this account.", 409);
  running.add(user);
  try {
    const signer = operator();
    const mandate = await mandateOf(user);
    if (!mandate) return [log({ user, trigger, kind: "skip", note: "No active mandate, so the agent did nothing." })];
    const now = Math.floor(Date.now() / 1000);
    if (now >= mandate.expiresAt) return [log({ user, trigger, kind: "skip", note: "The mandate has expired. Sign a new one to keep investing." })];

    const p = personality(mandate.profile) ?? personality("balanced")!;
    const usage = await read<{ period_start: bigint; spent: bigint }>(calls.usage(user));
    const spent = now >= Number(usage.period_start) + mandate.period ? 0n : BigInt(usage.spent);
    const left = mandate.limit - spent;
    const idle = (await walletUsdc(user)) - usdcToStroops(p.keep);
    const amount = idle < left ? idle : left;
    if (amount < MIN_INVEST) {
      const note =
        left < MIN_INVEST
          ? `This week's limit of ${stroopsToUsdc(mandate.limit)} USDC is already invested.`
          : `Less than 1 USDC is idle above the ${p.keep} USDC kept in your wallet, so nothing was invested.`;
      return [log({ user, trigger, kind: "skip", note })];
    }

    const done: Activity[] = [];
    for (const leg of split(amount, p, mandate.venues & reachable)) {
      const usdc = String(stroopsToUsdc(leg.amount));
      try {
        if (leg.venue === VENUE_CROSSCHAIN) {
          const fee = await bridgeFee();
          // Circle's fee is roughly fixed: below this a move would mostly pay gas.
          if (leg.amount < fee * 10n) {
            done.push(log({ user, trigger, kind: "skip", venue: leg.venue, amount: usdc, note: `${usdc} USDC is too little to move cross-chain; Circle's fee would eat most of it.` }));
            continue;
          }
          const { hash } = await invoke(signer, calls.invest(user, leg.venue, leg.amount, fee));
          done.push(log({ user, trigger, kind: "invest", venue: leg.venue, amount: usdc, hash, note: `Sent ${usdc} USDC to your wallet ${mandate.evmRecipient} on ${TESTNET_AGENT.destination.name} through Circle CCTP.` }));
          void followForward(user, hash, leg.amount, fee);
          continue;
        }
        const { hash } = await invoke(signer, calls.invest(user, leg.venue, leg.amount));
        done.push(log({ user, trigger, kind: "invest", venue: leg.venue, amount: usdc, hash, note: `Invested ${usdc} USDC into ${VENUES[leg.venue].name} on ${VENUES[leg.venue].place}.` }));
      } catch (e) {
        console.error(`agent invest failed for ${user}:`, e);
        done.push(log({ user, trigger, kind: "error", venue: leg.venue, amount: usdc, note: `${usdc} USDC was not invested: ${investFailure(e)} Your USDC stayed in your wallet.` }));
      }
    }
    return done;
  } finally {
    running.delete(user);
  }
}

/** Logs when Circle has minted a cross-chain move on the destination (usually within a minute). */
async function followForward(user: string, stellarHash: string, amount: bigint, maxFee: bigint) {
  const pending = { user, hash: stellarHash, amount: amount.toString(), fee: maxFee.toString() };
  setPending(pending);
  const f = await waitForForward(stellarHash, 20 * 60_000);
  setPending(pending, f.state !== "pending");
  const dest = TESTNET_AGENT.destination;
  if (f.state === "forwarded") {
    log({
      user,
      kind: "invest",
      venue: VENUE_CROSSCHAIN,
      amount: String(stroopsToUsdc(amount - maxFee)),
      link: f.forwardTxHash ? `${dest.explorer}/tx/${f.forwardTxHash}` : undefined,
      note: `Arrived on ${dest.name}: about ${stroopsToUsdc(amount - maxFee)} USDC in your wallet after Circle's gas fee.`,
    });
  } else {
    log({ user, kind: "error", venue: VENUE_CROSSCHAIN, note: `Circle has not delivered the cross-chain move from ${stellarHash.slice(0, 10)}… yet. The USDC is safe in CCTP; Nilo will keep checking.` });
  }
}

/** Registers a user whose mandate is on-chain, then invests right away. */
export async function activate(user: string): Promise<Activity[]> {
  const mandate = await mandateOf(user);
  if (!mandate) throw new AgentError("No mandate found on-chain for this account. Sign it first.", 404);
  addUser(user);
  log({ user, kind: "mandate", note: `Mandate active: up to ${stroopsToUsdc(mandate.limit)} USDC per week as ${personality(mandate.profile)?.name ?? mandate.profile}.` });
  return runFor(user, "activate");
}

export async function runAll() {
  for (const user of users()) {
    await runFor(user, "schedule").catch((e) => console.error(`agent run failed for ${user}:`, e));
  }
}

/** Starts the schedule when the operator key is configured. AGENT_INTERVAL_MINUTES, default 60. */
export function startSchedule() {
  if (!process.env.NILO_OPERATOR_SECRET) {
    console.warn("No NILO_OPERATOR_SECRET set: the investing agent is off.");
    return;
  }
  // Pick up cross-chain moves a restart interrupted.
  for (const p of pendingForwards()) void followForward(p.user, p.hash, BigInt(p.amount), BigInt(p.fee));
  const minutes = Number(process.env.AGENT_INTERVAL_MINUTES ?? 60);
  setInterval(() => void runAll(), Math.max(1, minutes) * 60_000);
  console.log(`Investing agent runs every ${minutes} min for ${users().length} account(s).`);
}
