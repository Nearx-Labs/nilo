import type { Claimant } from "@stellar/stellar-sdk";
import { type AssetSpec, parseHorizonAsset } from "./config";

type XdrPredicate = Claimant["predicate"];

/** T if the predicate is exactly `before_absolute_time(T)`. */
export function beforeAbsolute(p: XdrPredicate): bigint | null {
  return p.type === "claimPredicateBeforeAbsoluteTime" ? p.absBefore : null;
}

/** T if the predicate is exactly `not(before_absolute_time(T))`, i.e. "at or after T". */
export function notBeforeAbsolute(p: XdrPredicate): bigint | null {
  return p.type === "claimPredicateNot" && p.notPredicate ? beforeAbsolute(p.notPredicate) : null;
}

/** Predicate as Horizon serves it on /claimable_balances. */
export interface HorizonPredicate {
  unconditional?: boolean;
  and?: HorizonPredicate[];
  or?: HorizonPredicate[];
  not?: HorizonPredicate;
  abs_before?: string;
  abs_before_epoch?: string;
  rel_before?: string;
}

export interface HorizonClaimableBalance {
  id: string;
  asset: string;
  amount: string;
  sponsor?: string;
  claimants: Array<{ destination: string; predicate: HorizonPredicate }>;
}

function absEpoch(p: HorizonPredicate): number | null {
  if (p.abs_before_epoch) return Number(p.abs_before_epoch);
  if (p.abs_before) return Math.floor(Date.parse(p.abs_before) / 1000);
  return null;
}

/** Whether a ledger closing at `nowSec` would satisfy the predicate. */
export function evalPredicate(p: HorizonPredicate, nowSec: number): boolean {
  if (p.unconditional) return true;
  if (p.and) return p.and.every((q) => evalPredicate(q, nowSec));
  if (p.or) return p.or.some((q) => evalPredicate(q, nowSec));
  if (p.not) return !evalPredicate(p.not, nowSec);
  const abs = absEpoch(p);
  if (abs !== null) return nowSec < abs;
  // Horizon resolves relative predicates to absolute ones; anything left is unknown.
  return false;
}

export type BalanceStatus =
  /** Recipient, before the deadline. */
  | "claimable"
  /** Recipient, after the deadline: only the sender can take it back. */
  | "expired"
  /** Sender, after the deadline. */
  | "recoverable"
  /** Sender, before the deadline. */
  | "waiting";

export interface BalanceView {
  id: string;
  asset: AssetSpec;
  amount: string;
  role: "recipient" | "sender";
  sender?: string;
  recipient?: string;
  /** Unix seconds, when the balance follows the stellar-dots two-claimant shape. */
  deadline?: number;
  status: BalanceStatus;
  claimableNow: boolean;
}

/** How a balance looks from `me`'s side. Null when `me` is not a claimant. */
export function viewBalance(b: HorizonClaimableBalance, me: string, nowSec: number): BalanceView | null {
  const mine = b.claimants.find((c) => c.destination === me);
  if (!mine) return null;
  const role = b.sponsor === me ? "sender" : "recipient";
  const other = b.claimants.find((c) => c.destination !== me);
  const recipientClaimant = role === "recipient" ? mine : other;
  const deadline = recipientClaimant ? absEpoch(recipientClaimant.predicate) ?? undefined : undefined;
  const claimableNow = evalPredicate(mine.predicate, nowSec);
  const status: BalanceStatus =
    role === "recipient" ? (claimableNow ? "claimable" : "expired") : claimableNow ? "recoverable" : "waiting";
  return {
    id: b.id,
    asset: parseHorizonAsset(b.asset),
    amount: b.amount,
    role,
    sender: b.sponsor,
    recipient: role === "recipient" ? me : other?.destination,
    deadline,
    status,
    claimableNow,
  };
}
