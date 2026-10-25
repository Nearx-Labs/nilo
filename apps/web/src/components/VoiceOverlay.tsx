import { useEffect, useRef, useState } from "react";
import type { VoiceLevels, VoiceState } from "../voice";
import { CloseIcon } from "./icons";
import { VoiceCircuits } from "./VoiceCircuits";
import { VoiceOrb } from "./VoiceOrb";

const METER_BARS = 9;

/**
 * Voice mode as a voice-only HUD filling the chat panel: the orb with its rotors, circuit traces,
 * the state and what the assistant is doing, no transcript. The conversation still goes to the
 * chat history, which shows again when voice mode ends.
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
  const meter = useRef<HTMLSpanElement>(null);
  const live = useRef({ onEnd, levels, speaking });
  live.current = { onEnd, levels, speaking };

  useEffect(() => {
    end.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && live.current.onEnd();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The small HUD meter: written straight to the DOM every frame, like the composer's VoiceBar.
  useEffect(() => {
    const bars = [...(meter.current?.querySelectorAll<HTMLElement>("i") ?? [])];
    if (state !== "live" || !bars.length || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let level = 0;
    let frame = 0;
    const tick = (now: number) => {
      const { mic, out } = live.current.levels();
      const target = Math.min(1, Math.sqrt(live.current.speaking ? out : mic) * 1.8);
      level += (target - level) * (target > level ? 0.5 : 0.15);
      bars.forEach((b, i) => {
        const wobble = 0.6 + 0.4 * Math.sin(now / 140 + i * 1.7);
        b.style.setProperty("--lvl", String(Math.min(1, level * wobble)));
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      bars.forEach((b) => b.style.removeProperty("--lvl"));
    };
  }, [state]);

  const mood = state === "live" ? (speaking ? "speaking" : "listening") : state;
  const title =
    state === "connecting" ? "Connecting…" : state === "closing" ? "Ending…" : speaking ? `${name} is speaking` : "Listening…";
  const subtitle =
    task ??
    (state === "connecting"
      ? "Setting up a secure session"
      : state === "closing"
        ? "Closing the session"
        : speaking
          ? "Interrupt anytime"
          : "Speak naturally. I'm here to help.");
  const hud =
    state === "connecting" ? "Connecting..." : state === "closing" ? "Ending..." : speaking ? `${name} speaking` : "Listening...";

  return (
    <div className={`voice-overlay ${mood}`} role="region" aria-label="Voice mode">
      <p className="voice-tag">Voice mode · Payments agent</p>

      <div className="voice-stage">
        <VoiceCircuits side="left" />
        <VoiceOrb state={state} speaking={speaking} levels={levels} spectrum={spectrum} onSpeakingChange={setSpeaking} />
        <VoiceCircuits side="right" />
        <div className="voice-hud left" aria-hidden="true">
          //Voice
          <br />
          recognition
          <br />
          {state === "live" ? "active" : "standby"}
        </div>
        <div className="voice-hud right" aria-hidden="true">
          {hud}
          <span ref={meter} className="voice-hud-meter">
            {Array.from({ length: METER_BARS }, (_, i) => (
              <i key={i} />
            ))}
          </span>
        </div>
      </div>

      <div className="voice-text">
        <p className="voice-title" aria-hidden="true">
          {title}
        </p>
        <p className="voice-subtitle" aria-live="polite">
          {subtitle}
        </p>
        {/* Only the state is announced, not every change of who is speaking. */}
        <span className="sr-only" role="status">
          {state === "live" ? `Voice mode on. ${name} is listening.` : title}
        </span>
      </div>

      <div className="voice-cancel">
        <button
          ref={end}
          type="button"
          onClick={onEnd}
          disabled={state === "closing"}
          aria-label="End voice mode"
          title="End voice mode (Esc)"
        >
          <CloseIcon />
        </button>
        <span aria-hidden="true">Cancel</span>
      </div>
    </div>
  );
}
