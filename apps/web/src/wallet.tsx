// Wallet access through Pollar: login (Freighter, Albedo, email, Google…) and
// signing. The app only ever reads the public address; Pollar or the user's
// wallet holds the keys.
import { explain } from "@nilo/core";
import { type SubmitOutcome } from "@pollar/core";
import { usePollar, walletNotReadyReason } from "@pollar/react";
import { useEffect, useMemo, useRef } from "react";
import { config, requestSponsoredTrustline } from "./stellar";

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
 * Pollar creates the account of a new embedded wallet (email, Google…) but never
 * its trustlines. Once the account is on the ledger, Nilo's sponsor adds the ones
 * for the app's assets, paying the fee and reserve; the user only signs.
 * External wallets are skipped: they would get a signature prompt nobody asked for.
 */
export function useAutoTrustline() {
  const { address, custody, provisioning, signAndSubmit } = useWallet();
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (WATCH || !config.sponsor || !address || custody !== "internal") return;
    if (provisioning && provisioning !== "READY") return;
    if (tried.current.has(address)) return;
    tried.current.add(address);
    (async () => {
      const xdr = await requestSponsoredTrustline(address);
      if (!xdr) return;
      const e = explain(xdr, config);
      if (e.kind !== "trustline" || e.fields.account !== address) throw new Error(`refusing to sign: ${e.lines[0]}`);
      await signAndSubmit(xdr);
    })().catch((e) => {
      // Not fatal: a sponsored claim adds the trustline too. Retry when the wallet state changes.
      tried.current.delete(address);
      console.warn("Could not add the trustline:", (e as Error).message ?? e);
    });
  }, [address, custody, provisioning, signAndSubmit]);
}
