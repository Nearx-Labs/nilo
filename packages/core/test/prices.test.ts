import { describe, expect, it } from "vitest";
import {
  type Quote,
  MAX_QUOTE_AGE_SECONDS,
  assertFresh,
  assetToFiat,
  crossRate,
  defaultConfig,
  fiatToAsset,
  formatFiat,
  formatRate,
  isFiat,
  priceSymbol,
  usdQuote,
} from "../src";
import { NOW_SEC } from "./fixtures";

// Shapes and magnitudes from the testnet Reflector oracles (decimals = 14).
const q = (symbol: string, priceUsd: bigint, timestamp = NOW_SEC): Quote => ({ symbol, priceUsd, timestamp, oracle: "C…" });
const XLM = q("XLM", 25_000_000_000_000n); // 0.25 USD
const BRL = q("BRL", 18_000_000_000_000n); // 0.18 USD
const BTC = q("BTC", 8_057_302_130_979_519_954n); // ~80,573 USD
const USD = usdQuote(NOW_SEC);

describe("prices", () => {
  it("cross rates go through USD", () => {
    expect(formatRate(crossRate(XLM, USD))).toBe("0.2500");
    expect(formatRate(crossRate(XLM, BRL))).toBe("1.39");
    expect(formatRate(crossRate(BTC, USD))).toBe("80,573.02");
    expect(formatRate(crossRate(BRL, BTC))).toBe("0.000002234");
  });

  it("converts money to an asset amount, rounding down", () => {
    expect(fiatToAsset("10", USD, XLM)).toBe("40");
    // 50 BRL = 9 USD = 36 XLM
    expect(fiatToAsset("50", BRL, XLM)).toBe("36");
    // 1 BRL = 0.72 XLM exactly; 1/3 USD has no exact 7-decimal form and must round down
    expect(fiatToAsset("1", BRL, XLM)).toBe("0.72");
    expect(fiatToAsset("1", USD, q("X", 3n * 10n ** 14n))).toBe("0.3333333");
  });

  it("rejects bad fiat amounts", () => {
    expect(() => fiatToAsset("-5", USD, XLM)).toThrow(/positive number/);
    expect(() => fiatToAsset("1,5", USD, XLM)).toThrow(/positive number/);
    expect(() => fiatToAsset("0.0000001", BRL, BTC)).toThrow(/less than the smallest/);
    expect(() => fiatToAsset("1", USD, q("XLM", 0n))).toThrow(/no usable price/);
  });

  it("values an asset amount in money", () => {
    expect(assetToFiat("40", XLM, USD)).toBe("10");
    expect(formatFiat(assetToFiat("100", XLM, BRL), "BRL")).toBe("R$ 138.89");
  });

  it("rejects stale or empty quotes", () => {
    expect(() => assertFresh(XLM, NOW_SEC + 60)).not.toThrow();
    expect(() => assertFresh(XLM, NOW_SEC + MAX_QUOTE_AGE_SECONDS + 60)).toThrow(/too stale/);
    expect(() => assertFresh(q("XLM", 0n), NOW_SEC)).toThrow(/no usable price/);
  });

  it("maps assets and currencies to oracle symbols", () => {
    expect(priceSymbol(defaultConfig, "testusd")).toBe("USDC");
    expect(priceSymbol(defaultConfig, "xlm")).toBe("XLM");
    expect(isFiat(defaultConfig, "brl")).toBe(true);
    expect(isFiat(defaultConfig, "XLM")).toBe(false);
  });
});
