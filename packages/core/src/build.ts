import { Claimant, Operation, TransactionBuilder, type TransactionSource } from "@stellar/stellar-sdk";
import { type AppConfig, type AssetSpec, FEE_STROOPS, TX_VALIDITY_SECONDS, toSdkAsset } from "./config";
import type { ResolvedIntent } from "./validate";

export interface BuiltTx {
  xdr: string;
  /** Unix seconds. Recipient can claim strictly before it; sender can recover from it on. */
  deadline: number;
  /** ID the claimable balance will have once this transaction succeeds. */
  balanceId: string;
}

function txBuilder(source: TransactionSource, config: AppConfig, nowSec: number) {
  return new TransactionBuilder(source, {
    fee: String(FEE_STROOPS),
    networkPassphrase: config.networkPassphrase,
    timebounds: { minTime: 0, maxTime: nowSec + TX_VALIDITY_SECONDS },
  });
}

export function buildSendTx(intent: ResolvedIntent, source: TransactionSource, config: AppConfig, now: Date = new Date()): BuiltTx {
  const nowSec = Math.floor(now.getTime() / 1000);
  const deadline = nowSec + intent.deadlineSeconds;
  const before = Claimant.predicateBeforeAbsoluteTime(String(deadline));

  const tx = txBuilder(source, config, nowSec)
    .addOperation(
      Operation.createClaimableBalance({
        asset: toSdkAsset(intent.asset),
        amount: intent.amount,
        claimants: [
          new Claimant(intent.recipient, before),
          new Claimant(source.accountId(), Claimant.predicateNot(before)),
        ],
      }),
    )
    .build();

  return { xdr: tx.toXDR(), deadline, balanceId: tx.getClaimableBalanceId(0) };
}

/**
 * Claim (recipient) or recover (sender) a claimable balance. When `addTrustline`
 * is given, a changeTrust for that asset runs first in the same transaction.
 */
export function buildClaimTx(
  balanceId: string,
  source: TransactionSource,
  config: AppConfig,
  addTrustline?: AssetSpec,
  now: Date = new Date(),
): string {
  const nowSec = Math.floor(now.getTime() / 1000);
  const builder = txBuilder(source, config, nowSec);
  if (addTrustline) builder.addOperation(Operation.changeTrust({ asset: toSdkAsset(addTrustline) }));
  builder.addOperation(Operation.claimClaimableBalance({ balanceId }));
  return builder.build().toXDR();
}

/**
 * Claim paid for by the app's sponsor account: the sponsor is the transaction
 * source (so it pays the fee) and, when `addTrustline` is given, also sponsors
 * the trustline reserve. The claimant only signs; its XLM balance is untouched.
 */
export function buildSponsoredClaimTx(
  balanceId: string,
  sponsor: TransactionSource,
  claimant: string,
  config: AppConfig,
  addTrustline?: AssetSpec,
  now: Date = new Date(),
): string {
  const nowSec = Math.floor(now.getTime() / 1000);
  const builder = txBuilder(sponsor, config, nowSec);
  if (addTrustline) {
    builder
      .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: claimant }))
      .addOperation(Operation.changeTrust({ asset: toSdkAsset(addTrustline), source: claimant }))
      .addOperation(Operation.endSponsoringFutureReserves({ source: claimant }));
  }
  builder.addOperation(Operation.claimClaimableBalance({ balanceId, source: claimant }));
  return builder.build().toXDR();
}
