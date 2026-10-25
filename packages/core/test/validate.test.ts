import { describe, expect, it } from "vitest";
import { validateIntent } from "../src";
import { ALICE, MARIA, config, snapshot } from "./fixtures";

const ok = { amount: "50", asset: "TESTUSD", recipient: "maria", deadlineSeconds: 120 };
const rich = snapshot("100", "1000");

function reason(r: ReturnType<typeof validateIntent>) {
  return r.ok ? null : r.reason;
}

describe("validateIntent", () => {
  it("accepts a good intent and resolves the nickname", () => {
    const r = validateIntent(ok, rich, config);
    expect(r).toEqual({
      ok: true,
      intent: { amount: "50", asset: config.assets[1], recipient: MARIA, recipientName: "maria", deadlineSeconds: 120 },
    });
  });

  it("blocks an invalid address", () => {
    expect(reason(validateIntent({ ...ok, recipient: "GABC123" }, rich, config))).toMatch(/not a valid Stellar address/);
    // valid shape but bad checksum: last char changed
    const bad = MARIA.slice(0, -1) + (MARIA.endsWith("A") ? "B" : "A");
    expect(reason(validateIntent({ ...ok, recipient: bad }, rich, config))).toMatch(/not a valid Stellar address/);
  });

  it("blocks sending to yourself", () => {
    expect(reason(validateIntent({ ...ok, recipient: ALICE }, rich, config))).toMatch(/own account/);
  });

  it("blocks more than 7 decimal places", () => {
    expect(reason(validateIntent({ ...ok, amount: "1.12345678" }, rich, config))).toMatch(/7 decimal/);
    expect(validateIntent({ ...ok, amount: "1.1234567" }, rich, config).ok).toBe(true);
  });

  it("blocks zero, negative and non-numeric amounts", () => {
    for (const amount of ["0", "-5", "abc", "1e3", ""]) {
      expect(validateIntent({ ...ok, amount }, rich, config).ok).toBe(false);
    }
  });

  it("blocks unknown assets", () => {
    expect(reason(validateIntent({ ...ok, asset: "USDC" }, rich, config))).toMatch(/not supported/);
  });

  it("blocks insufficient asset balance", () => {
    expect(reason(validateIntent(ok, snapshot("100", "49.9999999"), config))).toMatch(/Insufficient TESTUSD/);
  });

  it("blocks when XLM cannot cover the 1 XLM claimable reserve plus fee", () => {
    // min balance with one trustline = 1.5 XLM; reserve 1 + fee 0.00001 => need 2.50001
    expect(reason(validateIntent(ok, snapshot("2.5", "1000"), config))).toMatch(/Insufficient XLM/);
    expect(validateIntent(ok, snapshot("2.50001", "1000"), config).ok).toBe(true);
  });

  it("counts the amount itself when sending XLM", () => {
    const xlm = { ...ok, asset: "XLM", amount: "10" };
    // min balance 1 + reserve 1 + fee + 10
    expect(reason(validateIntent(xlm, snapshot("12"), config))).toMatch(/Insufficient XLM/);
    expect(validateIntent(xlm, snapshot("12.00001"), config).ok).toBe(true);
  });

  it("blocks deadlines out of range", () => {
    expect(validateIntent({ ...ok, deadlineSeconds: 30 }, rich, config).ok).toBe(false);
    expect(validateIntent({ ...ok, deadlineSeconds: 31 * 24 * 3600 }, rich, config).ok).toBe(false);
  });
});
