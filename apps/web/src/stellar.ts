// Read-only Horizon access. Signing goes through Pollar (see wallet.tsx).
import { defaultConfig as config, type AccountSnapshot, type HorizonClaimableBalance } from "@nilo/core";
import { Horizon } from "@stellar/stellar-sdk";

export { config };
export const horizon = new Horizon.Server(config.horizonUrl);

/** Null when the account does not exist on the network. */
export async function loadAccount(address: string) {
  try {
    return await horizon.loadAccount(address);
  } catch (e) {
    if ((e as { response?: { status?: number } }).response?.status === 404) return null;
    throw e;
  }
}

/** Claimable balances where the address is a claimant, newest first. */
export async function fetchClaimable(address: string): Promise<HorizonClaimableBalance[]> {
  const page = await horizon.claimableBalances().claimant(address).limit(100).order("desc").call();
  return page.records as unknown as HorizonClaimableBalance[];
}

/** Testnet only: creates and funds an account that is not on the ledger yet. */
export async function friendbot(address: string) {
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error(`Friendbot could not fund ${address} (${res.status}).`);
}

/**
 * Asks the server for a claim the app's sponsor pays for (fee, and the trustline
 * reserve if needed), already signed by the sponsor. Throws with the server's reason.
 */
export async function requestSponsoredClaim(balanceId: string, claimant: string): Promise<string> {
  const res = await fetch("/api/sponsor-claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ balanceId, claimant }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.xdr !== "string") throw new Error(body.message ?? `Sponsor unavailable (${res.status}).`);
  return body.xdr;
}

/** Test USDC is offered below this balance (the server refuses at or above it). */
export const FAUCET_BELOW = "50";

/**
 * Asks the server for test USDC from the Sozu Faucet. The server rate-limits it;
 * a refusal throws with the reason and, when known, `retryAt` (unix ms).
 */
export async function requestFaucet(address: string): Promise<string> {
  const res = await fetch("/api/faucet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(body.message ?? `Faucet unavailable (${res.status}).`), { retryAt: body.retryAt as number | undefined });
  }
  return String(body.amount || "100");
}

export const asSnapshot = (a: Horizon.AccountResponse) => a as unknown as AccountSnapshot;

export const explorerTx = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;
