// Price math for Reflector oracle quotes. Pure: the web app reads the oracle and
// hands the quotes in. Every amount that can end up in a transaction is computed
// here with bigints, never by the model and never with floating point.
import { STROOPS_PER_UNIT, type AppConfig, fromStroops, toStroops } from "./config";

/** Reflector's Pulse oracles report prices with 14 decimals (checked on testnet via decimals()). */
export const PRICE_DECIMALS = 14;
export const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);
/** Oracles update every 300 s; a quote older than three updates is treated as stale. */
export const MAX_QUOTE_AGE_SECONDS = 900;

/** The price of one unit of `symbol` in USD, as the oracle reported it. */
export interface Quote {
  symbol: string;
  /** USD per unit, scaled by PRICE_SCALE. */
  priceUsd: bigint;
  /** Unix seconds of the oracle record. */
  timestamp: number;
  /** Contract that reported it; empty for USD itself. */
  oracle: string;
}

export const FIAT_SIGNS: Record<string, string> = { USD: "US$", BRL: "R$", EUR: "€" };

/** USD is the oracles' base, so it needs no lookup. */
export function usdQuote(nowSec: number): Quote {
  return { symbol: "USD", priceUsd: PRICE_SCALE, timestamp: nowSec, oracle: "" };
}

export function isFiat(config: AppConfig, symbol: string): boolean {
  return config.prices?.fiat.includes(symbol.toUpperCase()) ?? false;
}

/** Oracle symbol for an asset code: test assets can be priced as a real one (TESTUSD → USDC). */
export function priceSymbol(config: AppConfig, code: string): string {
  const upper = code.trim().toUpperCase();
  return config.prices?.symbols[upper] ?? upper;
}

export function assertFresh(q: Quote, nowSec: number): void {
  if (q.priceUsd <= 0n) throw new Error(`The oracle reported no usable price for ${q.symbol}.`);
  if (nowSec - q.timestamp > MAX_QUOTE_AGE_SECONDS) {
    const minutes = Math.round((nowSec - q.timestamp) / 60);
    throw new Error(`The ${q.symbol} price is ${minutes} minutes old, too stale to use.`);
  }
}

/** Price of one `base` in `quote` units, scaled by PRICE_SCALE. */
export function crossRate(base: Quote, quote: Quote): bigint {
  if (quote.priceUsd <= 0n) throw new Error(`The oracle reported no usable price for ${quote.symbol}.`);
  return (base.priceUsd * PRICE_SCALE) / quote.priceUsd;
}

const FIAT_RE = /^\d+(\.\d{1,7})?$/;

/**
 * How much of the asset `fiatAmount` buys, as a 7-decimal amount string.
 * Rounds down, so the payment is never worth more than what the user asked for.
 */
export function fiatToAsset(fiatAmount: string, fiat: Quote, asset: Quote): string {
  const amount = fiatAmount.trim();
  if (!FIAT_RE.test(amount)) {
    throw new Error(`Amount "${amount}" must be a positive number with at most 7 decimal places.`);
  }
  if (asset.priceUsd <= 0n) throw new Error(`The oracle reported no usable price for ${asset.symbol}.`);
  // Both prices share the same scale, so the ratio converts 7-decimal units directly.
  const stroops = (toStroops(amount) * fiat.priceUsd) / asset.priceUsd;
  if (stroops <= 0n) throw new Error(`${amount} ${fiat.symbol} is less than the smallest ${asset.symbol} amount.`);
  return fromStroops(stroops);
}

/** Value of an asset amount in `fiat`, as a 7-decimal amount string (rounded down). */
export function assetToFiat(amount: string, asset: Quote, fiat: Quote): string {
  if (fiat.priceUsd <= 0n) throw new Error(`The oracle reported no usable price for ${fiat.symbol}.`);
  return fromStroops((toStroops(amount) * asset.priceUsd) / fiat.priceUsd);
}

/** Display only: rounds a scaled value to `digits` decimals (half up). */
export function formatScaled(value: bigint, scale: bigint, digits: number): string {
  const step = scale / 10n ** BigInt(digits);
  const rounded = (value + step / 2n) / step;
  const unit = 10n ** BigInt(digits);
  const whole = (rounded / unit).toLocaleString("en-US");
  if (digits === 0) return whole;
  return `${whole}.${(rounded % unit).toString().padStart(digits, "0")}`;
}

/** Display only: enough decimals that small prices (e.g. 1 BRL in BTC) don't show as 0.00. */
export function formatRate(rate: bigint): string {
  if (rate >= PRICE_SCALE || rate <= 0n) return formatScaled(rate, PRICE_SCALE, 2);
  // Below 1: keep four significant digits.
  let zeros = 0;
  for (let r = rate; r * 10n < PRICE_SCALE && zeros < PRICE_DECIMALS - 4; r *= 10n) zeros++;
  return formatScaled(rate, PRICE_SCALE, zeros + 4);
}

/** Display only: a 7-decimal amount string as money, e.g. "R$ 12.34". */
export function formatFiat(amount: string, currency: string): string {
  const sign = FIAT_SIGNS[currency] ?? currency;
  return `${sign} ${formatScaled(toStroops(amount), STROOPS_PER_UNIT, 2)}`;
}
