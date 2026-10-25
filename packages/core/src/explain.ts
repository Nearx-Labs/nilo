// Turns a transaction XDR into plain English using fixed templates.
// It reads only the XDR: no LLM, no intent, no chain data. Anything that does
// not match one of the exact shapes this app builds is reported as unrecognized.
import { type Asset, FeeBumpTransaction, type Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  type AppConfig,
  type AssetSpec,
  CLAIMABLE_RESERVE_STROOPS,
  MAX_TRUST_LIMIT,
  assetLabel,
  fromStroops,
  nicknameFor,
  toStroops,
} from "./config";
import { beforeAbsolute, notBeforeAbsolute } from "./predicates";
import type { ResolvedIntent } from "./validate";

export interface SendFields {
  source: string;
  recipient: string;
  recipientName?: string;
  amount: string;
  asset: AssetSpec;
  /** Unix seconds. */
  deadline: number;
  fee: string;
  validUntil?: number;
  reserveXlm: string;
}

export interface ClaimFields {
  /** Transaction source: pays the fee. The claimant itself, or the app's sponsor. */
  source: string;
  /** Account that receives the balance. */
  claimant: string;
  /** Set when the app's sponsor pays the fee (and the trustline reserve, if any). */
  sponsored: boolean;
  balanceId: string;
  trustline?: AssetSpec;
  fee: string;
  validUntil?: number;
}

export interface TrustlineFields {
  /** Transaction source: the app's sponsor, which pays the fee and the reserve. */
  source: string;
  /** Account that gets the trustline. */
  account: string;
  asset: AssetSpec;
  fee: string;
  validUntil?: number;
}

export type Explanation =
  | { kind: "send"; fields: SendFields; lines: string[] }
  | { kind: "claim"; fields: ClaimFields; lines: string[] }
  | { kind: "trustline"; fields: TrustlineFields; lines: string[] }
  | { kind: "unrecognized"; reason: string; lines: string[] };

function spec(asset: Asset): AssetSpec {
  return asset.isNative() ? { code: "XLM" } : { code: asset.getCode(), issuer: asset.getIssuer() };
}

export function formatUtc(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function unrecognized(reason: string): Explanation {
  return {
    kind: "unrecognized",
    reason,
    lines: [
      "This transaction does not match anything this app builds.",
      `Reason: ${reason}`,
      "Do not sign it.",
    ],
  };
}

type Op = Transaction["operations"][number];

/**
 * Checks [beginSponsoringFutureReserves, changeTrust, endSponsoringFutureReserves]
 * where `sponsor` pays the reserve of a new trustline on `account`.
 * Returns the asset, or the reason the shape is wrong.
 */
function sponsoredTrust(ops: Op[], sponsor: string, account: string): AssetSpec | string {
  const [begin, trust, end] = ops;
  if (begin.type !== "beginSponsoringFutureReserves" || trust.type !== "changeTrust" || end.type !== "endSponsoringFutureReserves") {
    return `unexpected sponsored operations: ${ops.map((o) => o.type).join(", ")}.`;
  }
  if (begin.source && begin.source !== sponsor) return "the reserve sponsor is not the paying account.";
  if (begin.sponsoredId !== account) return "the sponsored account is not the one signing.";
  if (trust.source !== account || end.source !== account) return "the trustline is not added to the sponsored account.";
  if (!("getCode" in trust.line)) return "the trustline is for a liquidity pool share.";
  if (trust.limit !== MAX_TRUST_LIMIT) return `the trustline sets a limit of ${trust.limit}.`;
  return spec(trust.line as Asset);
}

export function explain(xdrBase64: string, config: AppConfig): Explanation {
  let tx;
  try {
    tx = TransactionBuilder.fromXDR(xdrBase64, config.networkPassphrase);
  } catch (e) {
    return unrecognized(`the XDR could not be decoded (${(e as Error).message}).`);
  }
  if (tx instanceof FeeBumpTransaction) return unrecognized("it is a fee-bump transaction.");
  if (tx.memo.type !== "none") return unrecognized("it carries a memo.");
  const sponsored = !!config.sponsor && tx.source === config.sponsor;
  // Only a sponsored claim may have operations acting for another account; its
  // shape is checked operation by operation below.
  if (!sponsored && tx.operations.some((op) => op.source && op.source !== tx.source)) {
    return unrecognized("an operation acts on behalf of a different account.");
  }

  const fee = fromStroops(BigInt(tx.fee));
  const validUntil = tx.timeBounds && tx.timeBounds.maxTime !== "0" ? Number(tx.timeBounds.maxTime) : undefined;
  const footer = [
    `Network: ${config.networkPassphrase}.`,
    `Maximum network fee: ${fee} XLM.`,
    validUntil ? `This transaction can only be submitted before ${formatUtc(validUntil)}.` : "This transaction never expires.",
  ];
  const ops = tx.operations;

  if (!sponsored && ops.length === 1 && ops[0].type === "createClaimableBalance") {
    const op = ops[0];
    if (op.claimants.length !== 2) return unrecognized(`it has ${op.claimants.length} claimants instead of 2.`);
    const recipientC = op.claimants.find((c) => beforeAbsolute(c.predicate) !== null);
    const senderC = op.claimants.find((c) => notBeforeAbsolute(c.predicate) !== null);
    if (!recipientC || !senderC || recipientC === senderC) {
      return unrecognized("the claim conditions are not \"recipient before T, sender after T\".");
    }
    if (senderC.destination !== tx.source) {
      return unrecognized("the account that can recover the funds is not the account paying.");
    }
    if (recipientC.destination === tx.source) return unrecognized("the recipient is the paying account.");
    const deadline = beforeAbsolute(recipientC.predicate)!;
    if (deadline !== notBeforeAbsolute(senderC.predicate)) {
      return unrecognized("the recipient's deadline and the sender's recovery time differ.");
    }

    const asset = spec(op.asset);
    const fields: SendFields = {
      source: tx.source,
      recipient: recipientC.destination,
      recipientName: nicknameFor(config, recipientC.destination),
      amount: fromStroops(toStroops(op.amount)),
      asset,
      deadline: Number(deadline),
      fee,
      validUntil,
      reserveXlm: fromStroops(CLAIMABLE_RESERVE_STROOPS),
    };
    const who = fields.recipientName ? `${fields.recipient} ("${fields.recipientName}")` : fields.recipient;
    return {
      kind: "send",
      fields,
      lines: [
        `Sends ${fields.amount} ${asset.code} from your account ${tx.source}.`,
        `Asset: ${assetLabel(asset)}.`,
        `Recipient: ${who}.`,
        `The recipient can claim it until ${formatUtc(fields.deadline)}.`,
        `From ${formatUtc(fields.deadline)} on, the recipient can no longer claim, and only you (${tx.source}) can recover the funds.`,
        `Until it is claimed or recovered, ${fields.reserveXlm} XLM of your balance stays locked as reserve.`,
        ...footer,
      ],
    };
  }

  const claimOp = ops[ops.length - 1];
  if (sponsored && ops.length === 3 && claimOp.type === "endSponsoringFutureReserves") {
    const account = claimOp.source;
    if (!account || account === tx.source) return unrecognized("the sponsor account adds a trustline to itself.");
    const asset = sponsoredTrust(ops, tx.source, account);
    if (typeof asset === "string") return unrecognized(asset);
    if (!config.assets.some((a) => a.code === asset.code && a.issuer === asset.issuer)) {
      return unrecognized(`${assetLabel(asset)} is not an asset this app uses.`);
    }
    return {
      kind: "trustline",
      fields: { source: tx.source, account, asset, fee, validUntil },
      lines: [
        `Adds a trustline so your account ${account} can hold ${assetLabel(asset)}.`,
        `Nilo's sponsor account ${tx.source} pays the network fee and the 0.5 XLM trustline reserve. Your XLM balance does not change.`,
        ...footer,
      ],
    };
  }
  if (sponsored) {
    if (claimOp.type !== "claimClaimableBalance" || !claimOp.source || claimOp.source === tx.source) {
      return unrecognized("the sponsor account is the source but this is not a claim by someone else.");
    }
    const claimant = claimOp.source;
    let trustline: AssetSpec | undefined;
    if (ops.length === 4) {
      const t = sponsoredTrust(ops, tx.source, claimant);
      if (typeof t === "string") return unrecognized(t);
      trustline = t;
    } else if (ops.length !== 1) {
      return unrecognized(`unexpected sponsored operations: ${ops.map((o) => o.type).join(", ")}.`);
    }
    const fields: ClaimFields = { source: tx.source, claimant, sponsored: true, balanceId: claimOp.balanceId, trustline, fee, validUntil };
    return {
      kind: "claim",
      fields,
      lines: [
        ...(trustline ? [`Adds a trustline so your account can hold ${assetLabel(trustline)}.`] : []),
        `Claims the pending balance ${claimOp.balanceId} into your account ${claimant}.`,
        trustline
          ? `Nilo's sponsor account ${tx.source} pays the network fee and the 0.5 XLM trustline reserve. Your XLM balance does not change.`
          : `Nilo's sponsor account ${tx.source} pays the network fee. Your XLM balance does not change.`,
        ...footer,
      ],
    };
  }

  if ((ops.length === 1 || ops.length === 2) && claimOp.type === "claimClaimableBalance") {
    let trustline: AssetSpec | undefined;
    if (ops.length === 2) {
      const first = ops[0];
      if (first.type !== "changeTrust") return unrecognized(`unexpected operation ${first.type} before the claim.`);
      if (!("getCode" in first.line)) return unrecognized("the trustline is for a liquidity pool share.");
      if (first.limit !== MAX_TRUST_LIMIT) return unrecognized(`the trustline sets a limit of ${first.limit}.`);
      trustline = spec(first.line as Asset);
    }
    const fields: ClaimFields = { source: tx.source, claimant: tx.source, sponsored: false, balanceId: claimOp.balanceId, trustline, fee, validUntil };
    return {
      kind: "claim",
      fields,
      lines: [
        ...(trustline ? [`Adds a trustline so your account can hold ${assetLabel(trustline)}. This reserves 0.5 XLM.`] : []),
        `Claims the pending balance ${claimOp.balanceId} into your account ${tx.source}.`,
        ...footer,
      ],
    };
  }

  return unrecognized(`unexpected operations: ${ops.map((o) => o.type).join(", ")}.`);
}

/**
 * Compares what the XDR says with what was validated. Any mismatch means the
 * builder and the explanation disagree, and the UI must refuse to sign.
 */
export function mismatches(expl: Explanation, expected: ResolvedIntent, source: string, deadline: number): string[] {
  if (expl.kind !== "send") return ["the transaction is not a send."];
  const f = expl.fields;
  const out: string[] = [];
  if (f.source !== source) out.push("source account");
  if (f.recipient !== expected.recipient) out.push("recipient");
  if (toStroops(f.amount) !== toStroops(expected.amount)) out.push("amount");
  if (f.asset.code !== expected.asset.code || f.asset.issuer !== expected.asset.issuer) out.push("asset");
  if (f.deadline !== deadline) out.push("deadline");
  return out;
}
