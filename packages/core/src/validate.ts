import { StrKey } from "@stellar/stellar-sdk";
import {
  type AppConfig,
  type AssetSpec,
  BASE_RESERVE_STROOPS,
  CLAIMABLE_RESERVE_STROOPS,
  FEE_STROOPS,
  MAX_DEADLINE_SECONDS,
  MIN_DEADLINE_SECONDS,
  fromStroops,
  toStroops,
} from "./config";
import type { SendIntent } from "./intent";

/** The subset of a Horizon account record that validation needs. */
export interface AccountSnapshot {
  account_id: string;
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
    selling_liabilities?: string;
  }>;
}

/** An intent after every deterministic check passed. */
export interface ResolvedIntent {
  amount: string;
  asset: AssetSpec;
  recipient: string;
  recipientName?: string;
  deadlineSeconds: number;
}

export type ValidationResult = { ok: true; intent: ResolvedIntent } | { ok: false; reason: string };

const AMOUNT_RE = /^\d+(\.\d{1,7})?$/;

export function resolveRecipient(config: AppConfig, input: string): { address: string; name?: string } | null {
  const trimmed = input.trim();
  const name = trimmed.toLowerCase();
  if (config.contacts[name]) return { address: config.contacts[name], name };
  if (StrKey.isValidEd25519PublicKey(trimmed)) return { address: trimmed };
  return null;
}

function balanceLine(account: AccountSnapshot, asset: AssetSpec) {
  return account.balances.find((b) =>
    asset.issuer
      ? b.asset_code === asset.code && b.asset_issuer === asset.issuer
      : b.asset_type === "native",
  );
}

/** XLM the account can spend without dropping below its minimum balance. */
export function spendableXlmStroops(account: AccountSnapshot): bigint {
  const native = balanceLine(account, { code: "XLM" });
  if (!native) return 0n;
  const entries =
    2n +
    BigInt(account.subentry_count) +
    BigInt(account.num_sponsoring ?? 0) -
    BigInt(account.num_sponsored ?? 0);
  const minBalance = entries * BASE_RESERVE_STROOPS;
  const liabilities = toStroops(native.selling_liabilities ?? "0");
  return toStroops(native.balance) - minBalance - liabilities;
}

export function validateIntent(intent: SendIntent, account: AccountSnapshot, config: AppConfig): ValidationResult {
  const recipient = resolveRecipient(config, intent.recipient);
  if (!recipient) {
    return { ok: false, reason: `"${intent.recipient}" is not a valid Stellar address (G...) or a known contact.` };
  }
  if (recipient.address === account.account_id) {
    return { ok: false, reason: "You cannot send to your own account." };
  }

  const asset = config.assets.find((a) => a.code.toUpperCase() === intent.asset.trim().toUpperCase());
  if (!asset) {
    const allowed = config.assets.map((a) => a.code).join(", ");
    return { ok: false, reason: `Asset "${intent.asset}" is not supported. Allowed: ${allowed}.` };
  }

  const amount = intent.amount.trim();
  if (!AMOUNT_RE.test(amount)) {
    return { ok: false, reason: `Amount "${amount}" must be a positive number with at most 7 decimal places.` };
  }
  const amountStroops = toStroops(amount);
  if (amountStroops <= 0n) {
    return { ok: false, reason: "Amount must be greater than zero." };
  }

  if (intent.deadlineSeconds < MIN_DEADLINE_SECONDS || intent.deadlineSeconds > MAX_DEADLINE_SECONDS) {
    return { ok: false, reason: "The deadline must be between 1 minute and 30 days." };
  }

  const line = balanceLine(account, asset);
  if (!line) {
    return { ok: false, reason: `Your account holds no ${asset.code}.` };
  }

  const xlmNeeded = CLAIMABLE_RESERVE_STROOPS + FEE_STROOPS + (asset.issuer ? 0n : amountStroops);
  const xlmAvailable = spendableXlmStroops(account);
  if (asset.issuer) {
    const available = toStroops(line.balance) - toStroops(line.selling_liabilities ?? "0");
    if (available < amountStroops) {
      return { ok: false, reason: `Insufficient ${asset.code}: you have ${fromStroops(available)}, need ${amount}.` };
    }
  }
  if (xlmAvailable < xlmNeeded) {
    return {
      ok: false,
      reason:
        `Insufficient XLM: this needs ${fromStroops(xlmNeeded)} XLM ` +
        `(${asset.issuer ? "" : "amount + "}${fromStroops(CLAIMABLE_RESERVE_STROOPS)} XLM reserve + fee), ` +
        `you can spend ${fromStroops(xlmAvailable > 0n ? xlmAvailable : 0n)} XLM.`,
    };
  }

  return {
    ok: true,
    intent: {
      amount,
      asset,
      recipient: recipient.address,
      recipientName: recipient.name,
      deadlineSeconds: intent.deadlineSeconds,
    },
  };
}

/** Same check for the claim page: can this account pay for a new trustline? */
export function canAffordTrustline(account: AccountSnapshot): boolean {
  return spendableXlmStroops(account) >= BASE_RESERVE_STROOPS + FEE_STROOPS * 2n;
}

export function hasTrustline(account: AccountSnapshot, asset: AssetSpec): boolean {
  return !asset.issuer || balanceLine(account, asset) !== undefined;
}

