// Test USDC for new wallets, from the Sozu Faucet (faucet.sozu.capital: Circle's
// testnet USDC, gated by a proof of work). This server is the only caller, and it
// checks the account and its own limits first, so the app can't be used to flood
// the faucet or to keep this server busy solving proofs of work.
import { createHash } from "node:crypto";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { type AccountSnapshot, defaultConfig as config, fromStroops, hasTrustline, toStroops } from "@nilo/core";
import { Horizon, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

export const FaucetRequest = z.object({
  address: z.string().refine((s) => StrKey.isValidEd25519PublicKey(s), "not a G... address"),
});

export class FaucetError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 429 | 502 | 503 = 400,
    /** Unix ms: when asking again can work. */
    readonly retryAt?: number,
  ) {
    super(message);
  }
}

const SOZU_URL = (process.env.SOZU_FAUCET_URL?.trim() || "https://faucet.sozu.capital").replace(/\/$/, "");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const LIMITS = {
  /** One successful claim per account per day. */
  perAddressMs: DAY,
  /** Attempts that reach Sozu, per client IP per day. */
  perIp: 3,
  /** Attempts that reach Sozu, for the whole server per hour. */
  perHour: 20,
  /** How long to leave Sozu alone after it says it is out, cooling down, or unreachable. */
  pauseMs: 30 * MINUTE,
  /** Refuse a proof of work harder than this (Sozu asks for 20: about 1M hashes, under a second). */
  maxDifficulty: 22,
  /** Accounts holding at least this much USDC don't need the faucet. */
  enough: "50",
};

const horizon = new Horizon.Server(config.horizonUrl);
const usdc = config.assets.find((a) => a.code === "USDC" && a.issuer);

/** Account → when it may ask again. */
const byAddress = new Map<string, number>();
/** Client IP → times of attempts that reached Sozu. */
const byIp = new Map<string, number[]>();
/** Times of attempts that reached Sozu, all clients. */
let recent: number[] = [];
/** Sozu is not called before this time. */
let pausedUntil = 0;
/** One claim at a time: at most one proof of work runs on this server. */
let busy = false;

function prune(now: number) {
  for (const [address, until] of byAddress) if (until <= now) byAddress.delete(address);
  for (const [ip, times] of byIp) {
    const kept = times.filter((t) => t > now - DAY);
    if (kept.length) byIp.set(ip, kept);
    else byIp.delete(ip);
  }
  recent = recent.filter((t) => t > now - HOUR);
}

interface SozuReply {
  success?: boolean;
  amount?: number | string;
  error?: string;
  reason?: string;
  nextAvailableAt?: string;
  challengeId?: string;
  prefix?: string;
  to?: string;
  difficulty?: number;
}

/** Sozu answered, but not with what we asked for. */
export class SozuRefused extends Error {
  constructor(
    readonly reply: SozuReply,
    readonly status: number,
  ) {
    super(reply.error ?? reply.reason ?? `HTTP ${status}`);
  }
}

async function post(path: string, body: unknown): Promise<{ status: number; reply: SozuReply }> {
  const res = await fetch(`${SOZU_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const reply = await res.json().catch(() => null);
  if (!reply || typeof reply !== "object") throw new Error(`Sozu ${path} returned HTTP ${res.status}, not JSON.`);
  return { status: res.status, reply };
}

function leadingZeroBits(hex: string): number {
  let bits = 0;
  for (const ch of hex) {
    const n = Number.parseInt(ch, 16);
    if (n === 0) {
      bits += 4;
      continue;
    }
    return bits + Math.clz32(n) - 28;
  }
  return bits;
}

/** Our own failure to solve a proof of work: not a reason to stop calling Sozu. */
class PowNotFound extends Error {}

/**
 * Same puzzle as Sozu's own CLI: sha256("prefix:challengeId:to:nonce") with `difficulty`
 * leading zero bits. Tries are geometric with mean 2^difficulty; 16× that fails once in ~10^7.
 */
async function solvePow(prefix: string, challengeId: string, to: string, difficulty: number): Promise<string> {
  const max = 2 ** difficulty * 16;
  for (let n = 0; n < max; n++) {
    if (n > 0 && n % 50_000 === 0) await yieldToLoop(); // keep serving other requests
    const nonce = String(n);
    if (leadingZeroBits(createHash("sha256").update(`${prefix}:${challengeId}:${to}:${nonce}`).digest("hex")) >= difficulty) {
      return nonce;
    }
  }
  throw new PowNotFound(`no proof of work found in ${max} tries.`);
}

/** Asks Sozu for test USDC for `to`. Throws SozuRefused when Sozu says no. No limits here: see requestFaucet. */
export async function claimFromSozu(to: string): Promise<{ amount: string }> {
  const challenge = await post("/api/v1/faucet/pow/challenge", { to });
  const { challengeId, prefix, difficulty } = challenge.reply;
  if (challenge.status >= 400 || typeof challengeId !== "string" || typeof prefix !== "string") {
    throw new SozuRefused(challenge.reply, challenge.status);
  }
  if (!Number.isInteger(difficulty) || difficulty! < 0 || difficulty! > LIMITS.maxDifficulty) {
    throw new SozuRefused({ reason: "difficulty_too_high", error: `proof of work difficulty ${difficulty} is above Nilo's limit.` }, 503);
  }
  const target = challenge.reply.to ?? to;
  const nonce = await solvePow(prefix, challengeId, target, difficulty!);
  const claim = await post("/api/v1/faucet/claim", { to: target, pow: { challengeId, nonce } });
  if (claim.status >= 400 || claim.reply.success !== true) throw new SozuRefused(claim.reply, claim.status);
  return { amount: String(claim.reply.amount ?? "") };
}

const PAUSING = new Set(["global_cooldown", "insufficient_vault", "empty_today", "difficulty_too_high"]);

/**
 * Test USDC for an account that can hold it and has little. The cheap limits run
 * first; only a request that passes every check reaches Sozu, and it counts
 * against the IP and server limits whether or not Sozu pays.
 */
export async function requestFaucet(req: z.infer<typeof FaucetRequest>, ip: string): Promise<{ amount: string }> {
  const now = Date.now();
  prune(now);
  if (!usdc) throw new FaucetError("This app has no USDC asset configured.", 503);
  if (now < pausedUntil) throw new FaucetError("The test USDC faucet is resting right now.", 503, pausedUntil);
  const until = byAddress.get(req.address);
  if (until) throw new FaucetError("This account already got test USDC today.", 429, until);
  const ipTimes = byIp.get(ip) ?? [];
  if (ipTimes.length >= LIMITS.perIp) throw new FaucetError("Too many faucet requests from your network today.", 429, ipTimes[0] + DAY);
  if (recent.length >= LIMITS.perHour) throw new FaucetError("The faucet is busy this hour.", 429, recent[0] + HOUR);
  if (busy) throw new FaucetError("Another faucet request is running. Try again in a few seconds.", 429, now + 10_000);

  busy = true;
  try {
    const account = await horizon.loadAccount(req.address).catch((e) => {
      if ((e as { response?: { status?: number } }).response?.status === 404) return null;
      throw e;
    });
    if (!account) throw new FaucetError("Your account does not exist on testnet yet.", 409);
    const snapshot = account as unknown as AccountSnapshot;
    if (!hasTrustline(snapshot, usdc)) {
      throw new FaucetError("Your account can't hold USDC yet: it has no USDC trustline.", 409);
    }
    const line = snapshot.balances.find((b) => b.asset_code === usdc.code && b.asset_issuer === usdc.issuer);
    if (line && toStroops(line.balance) >= toStroops(LIMITS.enough)) {
      throw new FaucetError(`You already have ${fromStroops(toStroops(line.balance))} USDC. The faucet is for accounts with less than ${LIMITS.enough}.`, 409);
    }

    recent.push(now);
    byIp.set(ip, [...ipTimes, now]);
    try {
      const out = await claimFromSozu(req.address);
      byAddress.set(req.address, now + LIMITS.perAddressMs);
      return out;
    } catch (e) {
      const next = e instanceof SozuRefused ? Date.parse(e.reply.nextAvailableAt ?? "") : NaN;
      const retryAt = next > now ? next : undefined;
      if (e instanceof SozuRefused && e.reply.reason === "user_cooldown") {
        byAddress.set(req.address, retryAt ?? now + LIMITS.perAddressMs);
        throw new FaucetError("The faucet says this account has to wait before asking again.", 429, byAddress.get(req.address));
      }
      if (e instanceof SozuRefused && !PAUSING.has(e.reply.reason ?? "") && e.status < 500) {
        throw new FaucetError(`The faucet refused: ${e.message}`, 502);
      }
      if (e instanceof PowNotFound) throw new FaucetError("Could not get test USDC this time. Try again.", 502);
      // Out of funds, cooling down, too hard, unreachable or broken: stop calling it for a while.
      pausedUntil = retryAt ?? now + LIMITS.pauseMs;
      console.warn("Sozu faucet paused until", new Date(pausedUntil).toISOString(), "-", (e as Error).message);
      throw new FaucetError("The test USDC faucet is resting right now.", 503, pausedUntil);
    }
  } finally {
    busy = false;
  }
}
