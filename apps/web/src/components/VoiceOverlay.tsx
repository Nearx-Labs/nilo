import { useEffect, useRef, useState } from "react";
import type { VoiceLevels, VoiceState } from "../voice";
import { CloseIcon } from "./icons";
import { VoiceOrb } from "./VoiceOrb";

/**
 * Voice mode as a full-screen, voice-only experience: the animated orb, one word of state and
 * what the assistant is doing, no transcript. The conversation still goes to the chat history,
 * which shows again when voice mode ends.
 */
export function VoiceOverlay({
  state,
  levels,
  spectrum,
  task,
  name,
  onEnd,
}: {
  state: VoiceState;
  levels: () => VoiceLevels;
  spectrum: (side: "mic" | "out", into: Uint8Array<ArrayBuffer>) => boolean;
  /** What a running tool is doing, e.g. "Checking your balance…". */
  task: string | null;
  name: string;
  onEnd: () => void;
}) {
  const [speaking, setSpeaking] = useState(false);
  const end = useRef<HTMLButtonElement>(null);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    end.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onEndRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const status =
    state === "connecting" ? "Connecting…" : state === "closing" ? "Ending…" : speaking ? `${name} is speaking` : "Listening";

  return (
    <div className={`voice-overlay ${state}${speaking ? " speaking" : ""}`} role="dialog" aria-modal="true" aria-label="Voice mode">
      <p className="voice-overlay-tag">Voice mode · experimental</p>
      <div className="voice-overlay-center">
        <VoiceOrb state={state} levels={levels} spectrum={spectrum} onSpeakingChange={setSpeaking} />
        <p className="voice-overlay-status" aria-hidden="true">
          {status}
        </p>
        <p className="voice-overlay-task" aria-live="polite">
          {task ?? ""}
        </p>
        {/* Only the state is announced, not every change of who is speaking. */}
        <span className="sr-only" role="status">
          {state === "live" ? `Voice mode on. ${name} is listening.` : status}
        </span>
      </div>
      <button
        ref={end}
        type="button"
        className="voice-overlay-end"
        onClick={onEnd}
        disabled={state === "closing"}
        aria-label="End voice mode"
        title="End voice mode (Esc)"
      >
        <CloseIcon />
      </button>
    </div>
  );
}
