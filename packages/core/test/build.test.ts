import { type Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { beforeAbsolute, buildSendTx, notBeforeAbsolute } from "../src";
import { ALICE, ISSUER, MARIA, NOW, NOW_SEC, aliceAccount, config } from "./fixtures";

const intent = {
  amount: "50",
  asset: { code: "TESTUSD", issuer: ISSUER },
  recipient: MARIA,
  deadlineSeconds: 120,
};

describe("buildSendTx", () => {
  const built = buildSendTx(intent, aliceAccount(), config, NOW);
  const tx = TransactionBuilder.fromXDR(built.xdr, config.networkPassphrase) as Transaction;
  const op = (tx as any).operations[0];

  it("creates a single claimable balance with the exact amount and asset", () => {
    expect((tx as any).operations).toHaveLength(1);
    expect(op.type).toBe("createClaimableBalance");
    expect(op.amount).toBe("50.0000000");
    expect(op.asset.getCode()).toBe("TESTUSD");
    expect(op.asset.getIssuer()).toBe(ISSUER);
  });

  it("has two claimants: recipient before the deadline, sender from the deadline on", () => {
    expect(built.deadline).toBe(NOW_SEC + 120);
    expect(op.claimants).toHaveLength(2);
    const [recipient, sender] = op.claimants;
    expect(recipient.destination).toBe(MARIA);
    expect(beforeAbsolute(recipient.predicate)).toBe(BigInt(built.deadline));
    expect(sender.destination).toBe(ALICE);
    expect(notBeforeAbsolute(sender.predicate)).toBe(BigInt(built.deadline));
  });

  it("is sourced by the sender and expires shortly", () => {
    expect(tx.source).toBe(ALICE);
    expect(Number((tx as any).timeBounds.maxTime)).toBeGreaterThan(NOW_SEC);
    expect(Number((tx as any).timeBounds.maxTime)).toBeLessThanOrEqual(NOW_SEC + 300);
  });
});
