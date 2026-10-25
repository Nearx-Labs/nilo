import { describe, expect, it } from "vitest";
import { type BalanceSelector, type BalanceView, pickBalances, viewBalance } from "../src";
import { ALICE, ISSUER, MARIA, STRANGER, config } from "./fixtures";

const T = 1_800_000_000;
const balance = {
  id: "00000000abc",
  asset: `TESTUSD:${ISSUER}`,
  amount: "50.0000000",
  sponsor: ALICE,
  claimants: [
    { destination: MARIA, predicate: { abs_before: new Date(T * 1000).toISOString(), abs_before_epoch: String(T) } },
    { destination: ALICE, predicate: { not: { abs_before_epoch: String(T) } } },
  ],
};

describe("viewBalance", () => {
  it("recipient can claim strictly before the deadline", () => {
    expect(viewBalance(balance, MARIA, T - 1)).toMatchObject({ role: "recipient", status: "claimable", deadline: T });
    expect(viewBalance(balance, MARIA, T)).toMatchObject({ status: "expired", claimableNow: false });
  });
  it("sender can recover from the deadline on", () => {
    expect(viewBalance(balance, ALICE, T - 1)).toMatchObject({ role: "sender", status: "waiting", recipient: MARIA });
    expect(viewBalance(balance, ALICE, T)).toMatchObject({ status: "recoverable", claimableNow: true });
  });
});

describe("pickBalances", () => {
  const view = (id: string, amount: string, code: string, sender: string): BalanceView => ({
    id,
    asset: code === "XLM" ? { code } : { code, issuer: ISSUER },
    amount,
    role: "recipient",
    sender,
    recipient: MARIA,
    deadline: T,
    status: "claimable",
    claimableNow: true,
  });
  const views = [view("a", "50.0000000", "TESTUSD", ALICE), view("b", "10.0000000", "XLM", ALICE), view("c", "50.0000000", "XLM", STRANGER)];
  const none: BalanceSelector = { index: null, counterparty: null, amount: null, asset: null };
  const ids = (sel: Partial<BalanceSelector>) => pickBalances(views, { ...none, ...sel }, config).map((v) => v.id);

  it("returns every payment when nothing is said", () => {
    expect(ids({})).toEqual(["a", "b", "c"]);
  });
  it("picks by position in the list, from 1", () => {
    expect(ids({ index: 2 })).toEqual(["b"]);
    expect(ids({ index: 0 })).toEqual([]);
    expect(ids({ index: 4 })).toEqual([]);
    expect(ids({ index: 1.5 })).toEqual([]);
  });
  it("picks by contact nickname or full address", () => {
    expect(ids({ counterparty: "Alice" })).toEqual(["a", "b"]);
    expect(ids({ counterparty: STRANGER.toLowerCase() })).toEqual(["c"]);
    expect(ids({ counterparty: "bob" })).toEqual([]);
  });
  it("compares amounts by value and assets by code", () => {
    expect(ids({ amount: "50" })).toEqual(["a", "c"]);
    expect(ids({ amount: "50", asset: "xlm" })).toEqual(["c"]);
    expect(ids({ amount: "fifty" })).toEqual([]);
  });
  it("needs every given field to match, the position included", () => {
    expect(ids({ index: 1, asset: "XLM" })).toEqual([]);
    expect(ids({ counterparty: "alice", asset: "TESTUSD" })).toEqual(["a"]);
  });
});
