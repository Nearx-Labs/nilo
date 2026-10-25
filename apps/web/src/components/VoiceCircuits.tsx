/**
 * Circuit traces running out of the voice orb, with data pulses travelling along them: inward
 * while listening, outward while the assistant speaks (set in CSS). Drawn for the left side and
 * mirrored for the right. The right edge of the 400×400 box touches the orb, centred at y = 200.
 */
const TRACES = [
  "M386 150 H330 L300 120 H210 L190 100 H60",
  "M391 175 H290 L270 155 H150 L135 140 H20",
  "M394 200 H260 L240 220 H110",
  "M391 225 H320 L295 250 H190 L170 270 H40",
  "M385 250 H340 L310 280 H250 L230 300 H130",
  "M377 128 H350 L330 108 H280",
  "M377 272 H355 L335 292",
];
const NODES: Array<[number, number]> = [
  [60, 100],
  [20, 140],
  [110, 220],
  [40, 270],
  [130, 300],
  [280, 108],
  [335, 292],
];

export function VoiceCircuits({ side }: { side: "left" | "right" }) {
  return (
    <svg className={`voice-circuits ${side}`} viewBox="0 0 400 400" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
      <g className="voice-traces">
        {TRACES.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <g className="voice-chips">
        <rect x="150" y="92" width="34" height="14" rx="1" />
        <rect x="60" y="212" width="40" height="16" rx="1" />
        <rect x="200" y="262" width="26" height="12" rx="1" />
        {[0, 1, 2, 3, 4].map((i) => (
          <rect key={i} x={170 + i * 9} y="150" width="5" height="9" />
        ))}
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={262 + i * 9} y="295" width="5" height="9" />
        ))}
      </g>
      <g className="voice-nodes">
        {NODES.map(([cx, cy]) => (
          <circle key={`${cx},${cy}`} cx={cx} cy={cy} r="3.5" />
        ))}
      </g>
      <g className="voice-pulses">
        {TRACES.map((d, i) => (
          <path key={d} d={d} pathLength={100} style={{ animationDelay: `${(i * 0.53) % 2.4}s` }} />
        ))}
      </g>
    </svg>
  );
}
