// Wallet access through Pollar: login (Freighter, Albedo, email, Google…) and
// signing. The app only ever reads the public address; Pollar or the user's
// wallet holds the keys.
import { hasTrustline } from "@nilo/core";
import { type SubmitOutcome } from "@pollar/core";
import { usePollar, walletNotReadyReason } from "@pollar/react";
import { useEffect, useMemo, useRef } from "react";
import { asSnapshot, config, friendbot, loadAccount } from "./stellar";

export class UserCancelled extends Error {}

export interface SubmitFailure {
  /** The transaction can be rebuilt and signed again (bad sequence, expired, timeout). */
  retryable: boolean;
  codes: string[];
  message: string;
}

export function isSubmitFailure(e: unknown): e is SubmitFailure {
  return typeof e === "object" && e !== null && "retryable" in e && "codes" in e;
}

const FRIENDLY: Record<string, string> = {
  tx_bad_seq: "The account's sequence number changed since the transaction was built.",
  tx_too_late: "The transaction expired before it was submitted.",
  tx_insufficient_balance: "Not enough XLM to pay for this transaction.",
  op_cannot_claim: "This balance cannot be claimed by you right now (the deadline rule does not allow it yet, or anymore).",
  op_low_reserve: "Not enough XLM to cover the reserve.",
  op_underfunded: "Not enough funds for this amount.",
  op_does_not_exist: "This balance no longer exists. It was already claimed or recovered.",
};

/** Turns a Pollar outcome into a hash, or throws UserCancelled / SubmitFailure. */
function toHash(outcome: SubmitOutcome): string {
  if (outcome.status === "success" || outcome.status === "pending") return outcome.hash;
  if (outcome.status === "cosign_pending") {
    throw { retryable: false, codes: [], message: "Waiting for your other device to approve. Refresh once it is approved." } satisfies SubmitFailure;
  }
  const text = `${outcome.code ?? ""} ${outcome.message ?? ""} ${outcome.details ?? ""}`;
  if (/CANCEL|DENIED|reject|declin|cancel|denied/i.test(text)) throw new UserCancelled(outcome.message ?? "Signature rejected.");
  const codes = (outcome.resultCode ?? "").split(/[\s,]+/).filter(Boolean);
  const retryable = codes.some((c) => c === "tx_bad_seq" || c === "tx_too_late") || /timeout/i.test(text);
  const message =
    codes.map((c) => FRIENDLY[c]).find(Boolean) ?? outcome.message ?? outcome.details ?? "Submission failed.";
  throw { retryable, codes, message } satisfies SubmitFailure;
}

// Dev only: ?watch=G... loads a public address without logging in, to inspect pages. Signing is disabled.
const WATCH = import.meta.env.DEV ? new URLSearchParams(location.search).get("watch") : null;

export function useWallet() {
  const { wallets, isAuthenticated, openLoginModal, signAndSubmitTx, setTrustline } = usePollar();
  return useMemo(() => {
    const stellar = wallets.find((w) => (w.chain ?? "STELLAR") === "STELLAR");
    // Claimable balances are classic operations: they need a G account, not a smart (C) wallet.
    const error =
      isAuthenticated && stellar?.custody === "smart"
        ? "Passkey smart wallets (C… addresses) can't create or claim claimable balances. Sign in with email, Google or a Stellar wallet."
        : isAuthenticated && !stellar
          ? "Your Pollar session has no Stellar wallet."
          : stellar?.provisioning === "FAILED"
            ? "Pollar could not create your account on testnet. Sign out and sign in again to retry."
            : null;
    const address = WATCH ?? (error ? null : (stellar?.address ?? null));
    return {
      address,
      custody: stellar?.custody ?? null,
      /** Pollar creates new accounts in the background: CREATING until it is on the ledger. */
      provisioning: stellar?.provisioning ?? null,
      fundingMode: stellar?.fundingMode ?? null,
      /** Why on-chain actions must wait (the account is still being created), or null. */
      notReady: WATCH ? null : walletNotReadyReason(stellar, "STELLAR"),
      error,
      connect: openLoginModal,
      async signAndSubmit(xdr: string): Promise<string> {
        if (WATCH) throw { retryable: false, codes: [], message: "Watch mode (?watch=) cannot sign." } satisfies SubmitFailure;
        return toHash(await signAndSubmitTx(xdr));
      },
      setTrustline,
    };
  }, [wallets, isAuthenticated, openLoginModal, signAndSubmitTx, setTrustline]);
}

/**
 * Gets a new embedded wallet (email, Google…) ready to use on testnet:
 * 1. The account. Pollar normally creates it in the background, but a wallet can
 *    come back without it (provisioning NONE, deferred funding, or READY with no
 *    account on the ledger). Unless Pollar says it is CREATING, Friendbot creates
 *    and funds it: no signature needed, testnet only.
 * 2. The trustlines for the app's assets, which Pollar never adds on its own.
 *    Pollar's setTrustline builds and submits them server-side (its embedded
 *    signer only signs transactions whose source is the wallet itself). If the
 *    Pollar app has no app wallet to sponsor them, the account pays its own reserve.
 * Runs once per address per page load, so a failure never turns into a stream of
 * signature prompts. External wallets are skipped for the same reason.
 */
export function useAutoTrustline() {
  const { address, custody, provisioning, fundingMode, setTrustline } = useWallet();
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (WATCH || !address || custody !== "internal") return;
    if (provisioning === "CREATING" || provisioning === "FAILED") return;
    if (tried.current.has(address)) return;
    tried.current.add(address);
    (async () => {
      let account = await loadAccount(address);
      if (!account) {
        console.info(`Account ${address} is not on testnet (Pollar provisioning: ${provisioning}, funding: ${fundingMode}). Creating it with Friendbot.`);
        await friendbot(address);
        account = await loadAccount(address);
        if (!account) throw new Error("Friendbot funded the account but Horizon does not show it yet.");
      }
      for (const asset of config.assets) {
        if (!asset.issuer || hasTrustline(asSnapshot(account), asset)) continue;
        const spec = { code: asset.code, issuer: asset.issuer };
        let out = await setTrustline(spec);
        // An app with no Pollar app wallet on this network can't sponsor: the account pays its own reserve.
        if (out.status === "error" && /APP_WALLET_NOT_FOUND/.test(out.details ?? "")) {
          out = await setTrustline(spec, { skipSponsorship: true });
        }
        if (out.status === "error") throw new Error(`${asset.code} trustline: ${out.details ?? "refused"}`);
      }
    })().catch((e) => {
      // Not fatal: claiming a payment adds the trustline too.
      console.warn("Could not set up the account:", (e as Error).message ?? e);
    });
  }, [address, custody, provisioning, fundingMode, setTrustline]);
}
