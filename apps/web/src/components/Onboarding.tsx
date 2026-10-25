// First sign-in: the user picks an investor profile while the account is set up
// in the background (account, USDC trustline, test USDC; see useAutoTrustline).
// The second step shows that setup finishing before the chat opens.
import { useEffect, useRef, useState } from "react";
import { PROFILES, type InvestorProfile, useProfile } from "../profile";
import { type SetupStep, useSetupStatus, useWallet } from "../wallet";
import { CloseIcon, RefreshIcon } from "./icons";

const ITEMS: { step: SetupStep; label: string }[] = [
  { step: "account", label: "Account created on testnet" },
  { step: "trustline", label: "USDC enabled" },
  { step: "usdc", label: "100 test USDC received" },
];

/**
 * `first`: the profile is required and the setup step follows.
 * `edit`: change the profile only; closable like any dialog.
 */
export function Onboarding({ mode, onClose }: { mode: "first" | "edit"; onClose: () => void }) {
  const { address, custody } = useWallet();
  const [profile, setProfile] = useProfile(address);
  const [picked, setPicked] = useState<InvestorProfile | null>(profile);
  const [phase, setPhase] = useState<"profile" | "setup">("profile");
  const status = useSetupStatus(address);
  const dialog = useRef<HTMLDivElement>(null);
  const closable = mode === "edit";

  // Only Nilo-prepared (embedded) wallets have a setup to wait for.
  const setupIndex =
    custody !== "internal" || status?.step === "done"
      ? ITEMS.length
      : status?.step === "failed"
        ? ITEMS.findIndex((i) => i.step === status.at)
        : Math.max(0, ITEMS.findIndex((i) => i.step === status?.step));
  const failed = status?.step === "failed" ? status.message : null;
  const ready = setupIndex === ITEMS.length || !!failed;

  // Tab stays inside the dialog; Escape closes it only when closing is allowed.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const el = dialog.current;
      if (!el) return;
      if (e.key === "Escape" && closable) {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab") {
        // Pollar's confirmation dialog can open on top: leave its focus alone.
        const other = document.activeElement?.closest('[role="dialog"], [aria-modal="true"]');
        if (other && other !== el) return;
        const items = el.querySelectorAll<HTMLElement>("button:not(:disabled)");
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (!active || active === el || !el.contains(active)) {
          e.preventDefault();
          (e.shiftKey ? last : first)?.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closable, onClose]);

  useEffect(() => dialog.current?.focus(), [phase]);

  function confirmProfile() {
    if (!picked) return;
    setProfile(picked);
    if (mode === "first" && custody === "internal") setPhase("setup");
    else onClose();
  }

  return (
    <div
      className="modal-backdrop under-wallet"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget || !closable) return;
        e.preventDefault();
        onClose();
      }}
    >
      <div ref={dialog} className="modal onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" tabIndex={-1}>
        <header className="modal-head">
          <h2 id="onboarding-title">{phase === "profile" ? "What kind of investor are you?" : "Getting your account ready"}</h2>
          {closable && (
            <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close">
              <CloseIcon />
            </button>
          )}
        </header>

        {phase === "profile" ? (
          <div className="modal-body onboarding-body">
            <p className="muted">
              {mode === "first"
                ? "Pick the profile that fits you best. Meanwhile we set up your Stellar account."
                : "You can change your profile at any time."}
            </p>
            <div className="profile-grid" role="group" aria-label="Investor profile">
              {PROFILES.map((p) => (
                <button key={p.id} type="button" className="profile-card" aria-pressed={picked === p.id} onClick={() => setPicked(p.id)}>
                  <strong>{p.label}</strong>
                  <span>{p.text}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="modal-body onboarding-body">
            <ul className="setup-list" aria-live="polite">
              {ITEMS.map((item, i) => {
                const state = i < setupIndex ? "done" : i === setupIndex ? (failed ? "failed" : "running") : "pending";
                return (
                  <li key={item.step} className={`setup-item ${state}`}>
                    <span className="setup-mark" aria-hidden="true">
                      {state === "done" ? "✓" : state === "failed" ? "!" : state === "running" ? <RefreshIcon width={16} height={16} className="spin" /> : "•"}
                    </span>
                    <span>{item.label}</span>
                    <span className="sr-only">{state === "done" ? "done" : state === "running" ? "in progress" : state}</span>
                  </li>
                );
              })}
            </ul>
            {failed && (
              <p className="warning small">
                Setup stopped: {failed} You can get test USDC later on the Claim page.
              </p>
            )}
            {status?.step === "trustline" && (
              <p className="warning small">Confirm the USDC activation in the Pollar window to continue.</p>
            )}
            {!ready && <p className="muted small">This takes up to half a minute.</p>}
          </div>
        )}

        <footer className="modal-foot">
          {phase === "profile" ? (
            <button type="button" disabled={!picked} onClick={confirmProfile}>
              {mode === "first" ? "Continue" : "Save"}
            </button>
          ) : (
            <button type="button" disabled={!ready} onClick={onClose}>
              {ready ? "Start chatting" : "Setting up…"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
