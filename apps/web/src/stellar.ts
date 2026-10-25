// Read-only Horizon access. Signing goes through Pollar (see wallet.tsx).
import { defaultConfig as config, type AccountSnapshot } from "@stellar-dots/core";
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

/** Testnet only: creates and funds an account that is not on the ledger yet. */
export async function friendbot(address: string) {
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error(`Friendbot could not fund ${address} (${res.status}).`);
}

export const asSnapshot = (a: Horizon.AccountResponse) => a as unknown as AccountSnapshot;

export const explorerTx = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;
