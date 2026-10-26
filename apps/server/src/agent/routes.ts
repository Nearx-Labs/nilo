// /api/agent: builds the unsigned transactions a user signs (mandate, revoke,
// withdraw), turns the agent on for them, runs it on request, and reports status.
// The browser decodes every transaction it gets from here before signing it.
import { StrKey } from "@stellar/stellar-sdk";
import { Hono } from "hono";
import { z } from "zod";
import { TESTNET_AGENT, agentCalls, allowanceFor, isEvmAddress, mandateFrom, personality, stroopsToUsdc, usdcToStroops } from "@nilo/core";
import { evmUsdc } from "./cctp";
import { AgentError, activate, mandateOf, runFor, walletUsdc } from "./run";
import { currentLedger, prepare, read } from "./soroban";
import { activityFor } from "./store";

const calls = agentCalls(TESTNET_AGENT);
const Account = z.string().refine((a) => StrKey.isValidEd25519PublicKey(a), "Invalid Stellar address.");
const MandateRequest = z.object({
  address: Account,
  personality: z.enum(["guardian", "balanced", "explorer"]),
  /** An advanced user's own weekly cap, in USDC; the personality's otherwise. */
  weeklyLimit: z.number().positive().max(1_000).optional(),
  days: z.number().int().min(1).max(90).optional(),
  /** The user's own EVM wallet; without it the mandate stays on Stellar. */
  evmRecipient: z.string().refine(isEvmAddress, "Invalid EVM address.").optional(),
});
const AddressRequest = z.object({ address: Account });
const WithdrawRequest = z.object({ address: Account, amount: z.string().regex(/^\d+(\.\d{1,7})?$/) });

const lastManualRun = new Map<string, number>();
const MANUAL_RUN_GAP_MS = 15_000;

const XOXNO_API = "https://testnet-api.xoxno.com/stellar-lending/v1/assets";
let apyCache: { at: number; apy: number | null } = { at: 0, apy: null };

/** XOXNO's current USDC supply APY on testnet (a fraction), cached for 5 minutes. */
async function xoxnoApy(): Promise<number | null> {
  if (Date.now() - apyCache.at < 300_000) return apyCache.apy;
  try {
    const res = await fetch(XOXNO_API);
    const body = (await res.json()) as { data?: unknown[] } | unknown[];
    const rows = (Array.isArray(body) ? body : (body.data ?? [])) as Record<string, unknown>[];
    const row = rows.find((r) => String(r.symbol ?? r.assetSymbol ?? "").toUpperCase() === "USDC" && Number(r.spokeId ?? r.spoke_id ?? 1) === 1)
      ?? rows.find((r) => String(r.symbol ?? r.assetSymbol ?? "").toUpperCase() === "USDC");
    const apy = row ? Number(row.supplyApy ?? row.supply_apy) : NaN;
    apyCache = { at: Date.now(), apy: Number.isFinite(apy) ? apy : null };
  } catch {
    apyCache = { at: Date.now(), apy: null };
  }
  return apyCache.apy;
}

async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new AgentError(parsed.error.issues[0]?.message ?? "Invalid request.");
  return parsed.data;
}

export const agent = new Hono();

agent.onError((e, c) => {
  if (e instanceof AgentError) return c.json({ message: e.message }, e.status);
  console.error("agent route failed:", e);
  // Only the user's own missing account is their problem; anything else is the network hiccuping.
  const missing = /Account not found: (G[A-Z2-7]{55})/.exec(String(e))?.[1];
  if (missing && missing !== TESTNET_AGENT.operator) return c.json({ message: "Your account is not on testnet yet." }, 404);
  return c.json({ message: "The Stellar network did not answer. Try again in a moment." }, 502);
});

agent.post("/mandate-tx", async (c) => {
  const { address, personality: id, weeklyLimit, days, evmRecipient } = await body(c.req.raw, MandateRequest);
  const now = Math.floor(Date.now() / 1000);
  const base = personality(id)!;
  const mandate = mandateFrom(weeklyLimit ? { ...base, weeklyLimit } : base, now, days ?? 30, TESTNET_AGENT.venues, evmRecipient);
  const allowance = allowanceFor(mandate, now, await currentLedger());
  const tx = await prepare(address, calls.setMandate(address, mandate, allowance.amount, allowance.ledger));
  return c.json({
    xdr: tx.toXDR(),
    mandate: { ...mandate, limit: mandate.limit.toString() },
    allowance: allowance.amount.toString(),
  });
});

agent.post("/revoke-tx", async (c) => {
  const { address } = await body(c.req.raw, AddressRequest);
  return c.json({ xdr: (await prepare(address, calls.revoke(address))).toXDR() });
});

agent.post("/withdraw-tx", async (c) => {
  const { address, amount } = await body(c.req.raw, WithdrawRequest);
  return c.json({ xdr: (await prepare(address, calls.withdraw(address, address, usdcToStroops(Number(amount))))).toXDR() });
});

agent.post("/activate", async (c) => {
  const { address } = await body(c.req.raw, AddressRequest);
  return c.json({ activity: await activate(address) });
});

agent.post("/run", async (c) => {
  const { address } = await body(c.req.raw, AddressRequest);
  const last = lastManualRun.get(address) ?? 0;
  if (Date.now() - last < MANUAL_RUN_GAP_MS) throw new AgentError("The agent just ran for this account. Try again in a few seconds.", 409);
  lastManualRun.set(address, Date.now());
  return c.json({ activity: await runFor(address, "manual") });
});

agent.get("/status/:address", async (c) => {
  const address = c.req.param("address");
  if (!StrKey.isValidEd25519PublicKey(address)) throw new AgentError("Invalid Stellar address.");
  const [mandate, usage, position, xoxno, wallet, apy] = await Promise.all([
    mandateOf(address),
    read<{ period_start: bigint; spent: bigint }>(calls.usage(address)),
    read<{ xoxno_account: bigint; xoxno_principal: bigint; bridged: bigint }>(calls.position(address)),
    read<bigint>(calls.xoxnoBalance(address)),
    walletUsdc(address),
    xoxnoApy(),
  ]);
  return c.json({
    mandate: mandate && { ...mandate, limit: stroopsToUsdc(mandate.limit), personality: personality(mandate.profile)?.name ?? mandate.profile },
    spentThisPeriod: stroopsToUsdc(BigInt(usage.spent)),
    periodStart: Number(usage.period_start),
    wallet: stroopsToUsdc(wallet),
    xoxno: { balance: stroopsToUsdc(BigInt(xoxno)), principal: stroopsToUsdc(BigInt(position.xoxno_principal)), account: Number(position.xoxno_account), apy },
    bridged: stroopsToUsdc(BigInt(position.bridged)),
    destination: {
      name: TESTNET_AGENT.destination.name,
      wallet: mandate?.evmRecipient ?? null,
      balance: mandate?.evmRecipient ? await evmUsdc(mandate.evmRecipient).catch(() => null) : null,
    },
    activity: activityFor(address),
  });
});
