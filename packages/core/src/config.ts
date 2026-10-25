import { Asset } from "@stellar/stellar-sdk";
import demo from "./demo.json";

export interface AssetSpec {
  code: string;
  /** Absent only for native XLM. */
  issuer?: string;
}

export interface AppConfig {
  networkPassphrase: string;
  horizonUrl: string;
  /** Assets the app is allowed to send. */
  assets: AssetSpec[];
  /** Fixed nickname → public key list for the demo. Lowercase keys. */
  contacts: Record<string, string>;
  /** Public key of the app's sponsor account, which may pay claim fees and trustline reserves. */
  sponsor?: string;
  /** Reflector price oracles (read-only, via Stellar RPC simulation). */
  prices?: PriceConfig;
}

export interface PriceConfig {
  rpcUrl: string;
  /** Reflector Pulse oracle for crypto prices in USD (CEX/DEX aggregate). */
  cryptoOracle: string;
  /** Reflector Pulse oracle for fiat exchange rates in USD. */
  forexOracle: string;
  /** Asset code → oracle symbol, for assets priced as another (e.g. a test stablecoin as USDC). */
  symbols: Record<string, string>;
  /** Fiat currencies a payment can be written in. */
  fiat: string[];
}

/** Reflector Pulse oracles on testnet: free to read, 14 decimals, a new record every 300 s. */
export const TESTNET_PRICES: PriceConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  cryptoOracle: "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63",
  forexOracle: "CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W",
  // The demo's assets (XLM, Circle's USDC) are quoted as they are; a self-issued test asset would map here.
  symbols: {},
  fiat: ["USD", "BRL", "EUR"],
};

export const defaultConfig: AppConfig = { ...demo, prices: TESTNET_PRICES };

export const STROOPS_PER_UNIT = 10_000_000n;
/** Base reserve on the Stellar network, in stroops (0.5 XLM). */
export const BASE_RESERVE_STROOPS = 5_000_000n;
/**
 * A claimable balance entry locks one base reserve per claimant, paid by the
 * creating account and returned when the balance is claimed or recovered.
 */
export const CLAIMANTS_PER_SEND = 2n;
export const CLAIMABLE_RESERVE_STROOPS = BASE_RESERVE_STROOPS * CLAIMANTS_PER_SEND;
export const FEE_STROOPS = 100n;
/** How long a built transaction stays valid for signing and submission. */
export const TX_VALIDITY_SECONDS = 180;
export const MIN_DEADLINE_SECONDS = 60;
export const MAX_DEADLINE_SECONDS = 30 * 24 * 3600;
/** changeTrust limit the SDK uses by default: the maximum int64, i.e. "no limit". */
export const MAX_TRUST_LIMIT = "922337203685.4775807";

export function toSdkAsset(spec: AssetSpec): Asset {
  return spec.issuer ? new Asset(spec.code, spec.issuer) : Asset.native();
}

export function sameAsset(a: AssetSpec, b: AssetSpec): boolean {
  return a.code === b.code && (a.issuer ?? null) === (b.issuer ?? null);
}

/** Horizon writes assets as "native" or "CODE:ISSUER". */
export function parseHorizonAsset(s: string): AssetSpec {
  if (s === "native") return { code: "XLM" };
  const [code, issuer] = s.split(":");
  return { code, issuer };
}

export function assetLabel(spec: AssetSpec): string {
  return spec.issuer ? `${spec.code} (issuer ${spec.issuer})` : "XLM (native lumens)";
}

export function nicknameFor(config: AppConfig, address: string): string | undefined {
  return Object.entries(config.contacts).find(([, pk]) => pk === address)?.[0];
}

export function toStroops(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(frac.padEnd(7, "0"));
}

export function fromStroops(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_UNIT;
  const frac = (stroops % STROOPS_PER_UNIT).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
