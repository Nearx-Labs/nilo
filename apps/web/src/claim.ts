// Claiming a pending payment, as the recipient or as the sender recovering it after the
// deadline. Used by the Claim and Sent pages and by voice mode in the chat.
import { type BalanceView, type Explanation, buildClaimTx, canAffordTrustline, hasTrustline, viewBalance } from "@nilo/core";
import type { Prepared } from "./components/SignPanel";
import { asSnapshot, config, fetchClaimable, loadAccount, requestSponsoredClaim } from "./stellar";

/** Ledger close times can trail the local clock by a few seconds. */
export const CLOCK_MARGIN = 5;

/** The account can't afford the trustline reserve the claim needs. */
export class TrustlineNeeded extends Error {}

/** The user's pending payments on one side, newest first. */
export async function loadPayments(address: string, role: BalanceView["role"], nowSec: number): Promise<BalanceView[]> {
  const records = await fetchClaimable(address);
  return records.map((r) => viewBalance(r, address, nowSec)).filter((v): v is BalanceView => v?.role === role);
}

/** Whether the claim can be signed now; a recovery waits a few seconds past the deadline. */
export function claimReady(v: BalanceView, nowSec: number): boolean {
  return v.claimableNow && (v.role === "recipient" || !v.deadline || nowSec >= v.deadline + CLOCK_MARGIN);
}

/**
 * Builds the claim of `v` for `address`. Throws TrustlineNeeded when the account has to
 * add a trustline it can't pay for.
 */
export async function prepareClaim(v: BalanceView, address: string, custody: string | null): Promise<Prepared> {
  const check = (e: Explanation) => {
    if (e.kind !== "claim") return ["transaction type"];
    const out: string[] = [];
    if (e.fields.balanceId !== v.id) out.push("balance");
    if (e.fields.claimant !== address) out.push("account");
    return out;
  };
  // Recipients claim for free: Nilo's sponsor pays the fee and any trustline reserve.
  // If the sponsor is unavailable, fall back to a claim the recipient pays for.
  // Not for embedded (email/Google) wallets: Pollar only signs transactions whose
  // source is the wallet itself, and those accounts are funded on creation anyway.
  if (v.role === "recipient" && config.sponsor && custody !== "internal") {
    try {
      return { xdr: await requestSponsoredClaim(v.id, address), check };
    } catch (e) {
      console.warn("Sponsored claim unavailable, falling back to self-paid:", (e as Error).message);
    }
  }
  const account = await loadAccount(address);
  if (!account) throw new Error("Your account does not exist on testnet yet. Fund it (e.g. Friendbot) and try again.");
  const asset = { code: v.asset.code, issuer: v.asset.issuer };
  const needsTrust = !hasTrustline(asSnapshot(account), asset);
  if (needsTrust && !canAffordTrustline(asSnapshot(account))) {
    throw new TrustlineNeeded(
      `To receive ${v.asset.code} your account needs a trustline, which reserves 0.5 XLM, and you don't have enough spare XLM.`,
    );
  }
  return { xdr: buildClaimTx(v.id, account, config, needsTrust ? asset : undefined), check };
}
