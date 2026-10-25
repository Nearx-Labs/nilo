import { useEffect, useRef } from "react";
import type { VoiceLevels, VoiceState } from "../voice";

/** Assistant loudness above which it counts as speaking. */
const SPEAKING = 0.02;
/** Keep "speaking" this long after it goes quiet, so the colour doesn't flicker between words. */
const HOLD_MS = 400;
const BARS = 64;

const COLORS = {
  idle: [140, 152, 168],
  listening: [72, 176, 255],
  speaking: [255, 178, 72],
} as const;

type Rgb = readonly [number, number, number];
const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r},${g},${b},${a})`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * The voice mode "reactor": rotating rings, radial bars from the live spectrum and a glow that
 * follows the loudness, blue while listening and amber while the assistant speaks. Drawn on a
 * canvas every animation frame, outside React.
 */
export function VoiceOrb({
  state,
  levels,
  spectrum,
  onSpeakingChange,
}: {
  state: VoiceState;
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
    const bars = new Float32Array(BARS);
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

    const draw = (now: number) => {
      const { state, levels, spectrum, onSpeakingChange } = live.current;
      const size = el.getBoundingClientRect().width;
      const c = size / 2;
      const R = size * 0.3;
      const t = still ? 0 : now / 1000;

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
      for (let i = 0; i < BARS; i++) {
        // Mirror the low half of the spectrum around the circle, where speech lives.
        const j = i < BARS / 2 ? i : BARS - 1 - i;
        const v = hasAudio ? bins[2 + Math.floor(j * 1.3)] / 255 : 0.06 + 0.04 * Math.sin(t * 2 + i * 0.5);
        bars[i] += (v - bars[i]) * (v > bars[i] ? 0.5 : 0.12);
      }

      ctx.clearRect(0, 0, size, size);
      ctx.lineCap = "round";

      // Glow.
      const glow = ctx.createRadialGradient(c, c, 0, c, c, R * (0.7 + 0.5 * level));
      glow.addColorStop(0, rgba(color, 0.55 + 0.35 * level));
      glow.addColorStop(0.45, rgba(color, 0.18 + 0.2 * level));
      glow.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(c, c, R * 1.3, 0, Math.PI * 2);
      ctx.fill();

      // Core ring.
      ctx.strokeStyle = rgba(color, 0.9);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c, c, R * (0.58 + 0.06 * level), 0, Math.PI * 2);
      ctx.stroke();

      // Radial bars.
      ctx.lineWidth = Math.max(2, size / 160);
      for (let i = 0; i < BARS; i++) {
        const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
        const r0 = R * 0.72;
        const r1 = r0 + 3 + bars[i] * R * 0.55;
        ctx.strokeStyle = rgba(color, 0.35 + 0.6 * bars[i]);
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
        ctx.stroke();
      }

      // Rotating arcs, faster while connecting.
      const spin = state === "live" ? 1 : 2.5;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rgba(color, 0.5);
      for (let k = 0; k < 3; k++) {
        const start = t * 0.25 * spin + (k * Math.PI * 2) / 3;
        ctx.beginPath();
        ctx.arc(c, c, R * 1.42, start, start + Math.PI * 0.42);
        ctx.stroke();
      }
      ctx.setLineDash([2, 7]);
      ctx.strokeStyle = rgba(color, 0.35);
      ctx.beginPath();
      ctx.arc(c, c, R * 1.3, -t * 0.4 * spin, -t * 0.4 * spin + Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Outer ticks.
      ctx.strokeStyle = rgba(color, 0.22);
      ctx.lineWidth = 1;
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2 + t * 0.05;
        const r0 = R * 1.56;
        const r1 = r0 + (i % 6 === 0 ? 8 : 4);
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
        ctx.stroke();
      }

      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={canvas} className="voice-orb" aria-hidden="true" />;
}
