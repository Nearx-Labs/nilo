// Read-only Reflector oracle access over Stellar RPC. Each read is a simulated
// contract call: nothing is signed or submitted, and it costs nothing.
import { type Quote, assertFresh, isFiat, usdQuote } from "@nilo/core";
import { Account, Contract, Keypair, TransactionBuilder, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { config } from "./stellar";

const prices = config.prices!;
const server = new rpc.Server(prices.rpcUrl);
// Simulation needs a source account but never loads or charges it.
const reader = new Account(Keypair.random().publicKey(), "0");
/** Oracle records change every 300 s; a minute of caching keeps the chat snappy. */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; quote: Quote }>();

async function simulate(contractId: string, method: string, ...args: xdr.ScVal[]): Promise<unknown> {
  const tx = new TransactionBuilder(reader, { fee: "100", networkPassphrase: config.networkPassphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`Oracle call failed: ${sim.error.split("\n")[0]}`);
  return sim.result ? scValToNative(sim.result.retval) : undefined;
}

/** Symbols an oracle quotes, for "not found" messages. */
async function listed(contractId: string): Promise<string[]> {
  const assets = (await simulate(contractId, "assets")) as Array<[string, string]>;
  return assets.filter(([tag]) => tag === "Other").map(([, sym]) => sym);
}

/** USD price of a symbol from the matching Reflector oracle; throws if missing or stale. */
export async function getQuote(symbol: string): Promise<Quote> {
  const sym = symbol.trim().toUpperCase();
  const now = Math.floor(Date.now() / 1000);
  if (sym === "USD") return usdQuote(now);
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.quote;

  // Crypto symbols live in one oracle; currencies, metals and anything else in the forex one.
  const oracle = !isFiat(config, sym) && (await isCrypto(sym)) ? prices.cryptoOracle : prices.forexOracle;
  const asset = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol(sym)]);
  const record = (await simulate(oracle, "lastprice", asset)) as { price: bigint; timestamp: bigint } | undefined;
  if (!record) {
    const known = [...(await listed(prices.cryptoOracle)), ...(await listed(prices.forexOracle))];
    throw new Error(`The Reflector testnet oracles have no price for ${sym}. Available: ${known.join(", ")}.`);
  }
  const quote: Quote = { symbol: sym, priceUsd: BigInt(record.price), timestamp: Number(record.timestamp), oracle };
  assertFresh(quote, now);
  cache.set(sym, { at: Date.now(), quote });
  return quote;
}

let cryptoSymbols: Promise<string[]> | null = null;
/** Whether the crypto oracle lists a symbol; its list is fetched once. */
async function isCrypto(sym: string): Promise<boolean> {
  cryptoSymbols ??= listed(prices.cryptoOracle).catch((e) => {
    cryptoSymbols = null;
    throw e;
  });
  return (await cryptoSymbols).includes(sym);
}

/** Short form of a contract ID for display, e.g. CCYO…RN63. */
export const shortContract = (id: string) => `${id.slice(0, 4)}…${id.slice(-4)}`;
