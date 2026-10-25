import { useEffect, useRef } from "react";
import type { VoiceLevels, VoiceState } from "../voice";
import { MicIcon, WaveformIcon } from "./icons";

/** Assistant loudness above which it counts as speaking. */
const SPEAKING = 0.02;
/** Keep "speaking" this long after it goes quiet, so the colour doesn't flicker between words. */
const HOLD_MS = 400;
const TICKS = 120;

const COLORS = {
  idle: [120, 140, 165],
  listening: [56, 189, 255],
  speaking: [255, 178, 72],
} as const;

type Rgb = readonly [number, number, number];
const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const TAU = Math.PI * 2;

/**
 * The voice mode "reactor": rotors turning at different speeds and directions, a thick arc that
 * swells with the loudness, a tick ring driven by the live spectrum and a dark core with the
 * mic (or a waveform while the assistant speaks). Blue while listening, amber while speaking.
 * Drawn on a canvas every animation frame, outside React.
 */
export function VoiceOrb({
  state,
  speaking,
  levels,
  spectrum,
  onSpeakingChange,
}: {
  state: VoiceState;
  speaking: boolean;
  levels: () => VoiceLevels;
  spectrum: (side: "mic" | "out", into: Uint8Array<ArrayBuffer>) => boolean;
  onSpeakingChange: (speaking: boolean) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ state, levels, spectrum, onSpeakingChange });
  live.current = { state, levels, spectrum, onSpeakingChange };

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const bins = new Uint8Array(128);
    const ticks = new Float32Array(TICKS);
    let color: Rgb = COLORS.idle;
    let level = 0;
    let speaking = false;
    let speakingUntil = 0;
    let frame = 0;

    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const { width } = el.getBoundingClientRect();
      el.width = el.height = Math.round(width * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);

    const arc = (r: number, from: number, to: number, width: number, style: string | CanvasGradient) => {
      ctx.lineWidth = width;
      ctx.strokeStyle = style;
      ctx.beginPath();
      ctx.arc(c, c, r, from, to);
      ctx.stroke();
    };
    let c = 0;

    const draw = (now: number) => {
      const { state, levels, spectrum, onSpeakingChange } = live.current;
      const size = el.getBoundingClientRect().width;
      c = size / 2;
      const H = size / 2;
      const t = still ? 0 : now / 1000;
      const spin = state === "live" ? 1 : 2.2;

      const { mic, out } = state === "live" ? levels() : { mic: 0, out: 0 };
      if (out > SPEAKING && out > mic) speakingUntil = now + HOLD_MS;
      const nowSpeaking = state === "live" && now < speakingUntil;
      if (nowSpeaking !== speaking) onSpeakingChange((speaking = nowSpeaking));

      const target = state !== "live" ? COLORS.idle : speaking ? COLORS.speaking : COLORS.listening;
      color = mix(color, target, 0.08);
      // Speech is quiet in RMS terms: the square root lifts it into a visible range.
      const goal = Math.min(1, Math.sqrt(speaking ? out : mic) * 1.8);
      level += (goal - level) * (goal > level ? 0.4 : 0.1);

      const hasAudio = state === "live" && spectrum(speaking ? "out" : "mic", bins);
      for (let i = 0; i < TICKS; i++) {
        // Mirror the low half of the spectrum around the ring, where speech lives.
        const j = i < TICKS / 2 ? i : TICKS - 1 - i;
        const v = hasAudio ? bins[2 + Math.floor(j * 0.75)] / 255 : 0.05 + 0.04 * Math.sin(t * 2.4 + i * 0.35);
        ticks[i] += (v - ticks[i]) * (v > ticks[i] ? 0.5 : 0.12);
      }

      ctx.clearRect(0, 0, size, size);
      ctx.lineCap = "butt";

      // Back glow.
      const glow = ctx.createRadialGradient(c, c, H * 0.3, c, c, H * 0.95);
      glow.addColorStop(0, rgba(color, 0.22 + 0.25 * level));
      glow.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);

      // 1. Outer rotor: three long segments, slow.
      for (let k = 0; k < 3; k++) {
        const a = t * 0.12 * spin + (k * TAU) / 3;
        arc(H * 0.96, a, a + TAU / 3 - 0.35, 1.5, rgba(color, 0.55));
      }
      arc(H * 0.9, 0, TAU, 1, rgba(color, 0.18));

      // 2. Technical rotor: bracket segments and a dashed track, the other way.
      const b = -t * 0.22 * spin;
      for (let k = 0; k < 6; k++) {
        const a = b + (k * TAU) / 6;
        arc(H * 0.82, a, a + 0.42, 4, rgba(color, 0.7));
      }
      ctx.setLineDash([1.5, 5]);
      arc(H * 0.82, 0, TAU, 1, rgba(color, 0.35));
      ctx.setLineDash([]);

      // 3. Thick arc that swells with the voice.
      const thick = H * (0.045 + 0.04 * level);
      arc(H * 0.7, 0, TAU, thick, rgba(color, 0.1));
      const a3 = t * 0.38 * spin;
      let stroke: string | CanvasGradient = rgba(color, 0.9);
      if ("createConicGradient" in ctx) {
        const g = ctx.createConicGradient(a3, c, c);
        g.addColorStop(0, rgba(color, 0.15));
        g.addColorStop(0.72, rgba(color, 0.95 + 0.05 * level));
        g.addColorStop(0.73, rgba(color, 0));
        g.addColorStop(1, rgba(color, 0));
        stroke = g;
      }
      ctx.shadowColor = rgba(color, 0.8);
      ctx.shadowBlur = 12 + 18 * level;
      arc(H * 0.7, a3, a3 + TAU * 0.72, thick, stroke);
      ctx.shadowBlur = 0;

      // 4. Tick ring from the spectrum.
      const base = t * 0.05;
      ctx.lineWidth = 1.2;
      for (let i = 0; i < TICKS; i++) {
        const a = base + (i / TICKS) * TAU - Math.PI / 2;
        const r0 = H * 0.5;
        const r1 = r0 + H * 0.025 + ticks[i] * H * 0.11;
        ctx.strokeStyle = rgba(color, 0.3 + 0.65 * ticks[i]);
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
        ctx.stroke();
      }

      // 5. Inner ring and the dark core.
      const core = ctx.createRadialGradient(c, c - H * 0.1, 0, c, c, H * 0.4);
      core.addColorStop(0, speaking ? "#1d1408" : "#0b1a2b");
      core.addColorStop(1, speaking ? "#0c0804" : "#050c16");
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(c, c, H * 0.4, 0, TAU);
      ctx.fill();
      ctx.shadowColor = rgba(color, 0.9);
      ctx.shadowBlur = 10 + 14 * level;
      arc(H * 0.4, 0, TAU, 2, rgba(color, 0.95));
      ctx.shadowBlur = 0;
      arc(H * 0.44, 0, TAU, 1, rgba(color, 0.3));

      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="voice-orb" aria-hidden="true">
      <canvas ref={canvas} />
      <span className="voice-orb-icon">{speaking ? <WaveformIcon /> : <MicIcon />}</span>
    </div>
  );
}
