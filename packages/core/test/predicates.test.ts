import { describe, expect, it } from "vitest";
import { viewBalance } from "../src";
import { ALICE, ISSUER, MARIA } from "./fixtures";

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
