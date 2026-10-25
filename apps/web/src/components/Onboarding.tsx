// First sign-in: the user answers the investor questionnaire, which sets their
// profile, while the account is set up in the background (account, USDC
// trustline, test USDC; see useAutoTrustline). The last step shows that setup
// finishing before the chat opens.
import { useEffect, useRef, useState } from "react";
import { MAX_SCORE, PROFILES, QUESTIONS, scoreProfile, useProfile } from "../profile";
import { type SetupStep, useSetupStatus, useWallet } from "../wallet";
import { CloseIcon, RefreshIcon } from "./icons";

const ITEMS: { step: SetupStep; label: string }[] = [
  { step: "account", label: "Account created on testnet" },
  { step: "trustline", label: "USDC enabled" },
  { step: "usdc", label: "100 test USDC received" },
];

/**
 * `first`: the questionnaire is required and the setup step follows.
 * `edit`: retake the questionnaire only; closable like any dialog.
 */
export function Onboarding({ mode, onClose }: { mode: "first" | "edit"; onClose: () => void }) {
  const { address, custody } = useWallet();
  const [, setProfile] = useProfile(address);
  const [phase, setPhase] = useState<"quiz" | "result" | "setup">("quiz");
  // Index of the chosen option per question; kept so Back shows earlier answers.
  const [answers, setAnswers] = useState<(number | null)[]>(() => QUESTIONS.map(() => null));
  const [current, setCurrent] = useState(0);
  const question = QUESTIONS[current];
  const score = answers.reduce<number>((sum, a, i) => sum + (a === null ? 0 : QUESTIONS[i].options[a].points), 0);
  const result = PROFILES.find((p) => p.id === scoreProfile(score))!;
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

  useEffect(() => dialog.current?.focus(), [phase, current]);

  function next() {
    if (answers[current] === null) return;
    if (current < QUESTIONS.length - 1) {
      setCurrent(current + 1);
      return;
    }
    // Saved now, so a reload during setup does not ask again.
    setProfile(result.id);
    setPhase("result");
  }

  function finishResult() {
    if (mode === "first" && custody === "internal") setPhase("setup");
    else onClose();
  }

  const title =
    phase === "quiz" ? "What kind of investor are you?" : phase === "result" ? "Your investor profile" : "Getting your account ready";

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
          <h2 id="onboarding-title">{title}</h2>
          {closable && (
            <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close">
              <CloseIcon />
            </button>
          )}
        </header>

        {phase === "quiz" ? (
          <div className="modal-body onboarding-body">
            {current === 0 && mode === "first" && (
              <p className="muted">Five quick questions to find your profile. Meanwhile we set up your Stellar account.</p>
            )}
            <div className="quiz-progress">
              <span>
                {question.category} · Question {current + 1} of {QUESTIONS.length}
              </span>
              <div className="quiz-bar" aria-hidden="true">
                <i style={{ width: `${((current + 1) / QUESTIONS.length) * 100}%` }} />
              </div>
            </div>
            <p className="quiz-prompt" id="quiz-prompt">
              {question.prompt}
            </p>
            <div className="profile-grid" role="group" aria-labelledby="quiz-prompt">
              {question.options.map((o, i) => (
                <button
                  key={o.letter}
                  type="button"
                  className="profile-card"
                  aria-pressed={answers[current] === i}
                  onClick={() => setAnswers((a) => a.map((v, q) => (q === current ? i : v)))}
                >
                  <strong>{o.letter}</strong>
                  <span>{o.text}</span>
                </button>
              ))}
            </div>
          </div>
        ) : phase === "result" ? (
          <div className="modal-body onboarding-body quiz-result">
            <p className="muted">You are</p>
            <p className="quiz-profile">{result.label}</p>
            <p>{result.detail}</p>
            <p className="muted small">
              Score: {score} of {MAX_SCORE}
            </p>
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
          {phase === "quiz" ? (
            <>
              {current > 0 && (
                <button type="button" className="secondary" onClick={() => setCurrent(current - 1)}>
                  Back
                </button>
              )}
              <button type="button" disabled={answers[current] === null} onClick={next}>
                {current < QUESTIONS.length - 1 ? "Next" : "See my profile"}
              </button>
            </>
          ) : phase === "result" ? (
            <button type="button" onClick={finishResult}>
              {mode === "first" && custody === "internal" ? "Continue" : "Done"}
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
