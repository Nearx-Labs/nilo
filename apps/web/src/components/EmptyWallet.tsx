// Illustration for empty payment lists: a wallet with a coin and a check mark.
export function EmptyWallet() {
  return (
    <svg className="empty-art" viewBox="0 0 200 130" width="200" height="130" aria-hidden="true">
      <defs>
        <linearGradient id="ew-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7b6cff" />
          <stop offset="1" stopColor="#4a3cc9" />
        </linearGradient>
        <linearGradient id="ew-back" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5d4fe0" />
          <stop offset="1" stopColor="#392d9e" />
        </linearGradient>
        <linearGradient id="ew-coin" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c9c3ff" />
          <stop offset="1" stopColor="#7d70ea" />
        </linearGradient>
        <radialGradient id="ew-shadow">
          <stop offset="0" stopColor="#000" stopOpacity="0.45" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="100" cy="116" rx="62" ry="9" fill="url(#ew-shadow)" />
      {/* Coin rising out of the wallet */}
      <g transform="rotate(-18 104 28)">
        <ellipse cx="104" cy="30" rx="20" ry="9" fill="#6a5ee0" />
        <ellipse cx="104" cy="26" rx="20" ry="9" fill="url(#ew-coin)" />
        <ellipse cx="104" cy="26" rx="13" ry="5.5" fill="none" stroke="#efeaff" strokeOpacity="0.7" strokeWidth="1.5" />
      </g>
      {/* Back flap */}
      <path d="M58 52 q0-12 12-14 l58-8 q12-1 13 11 l1 10 z" fill="url(#ew-back)" />
      {/* Body */}
      <rect x="52" y="48" width="96" height="64" rx="16" fill="url(#ew-body)" />
      <rect x="52" y="48" width="96" height="64" rx="16" fill="none" stroke="#a79dff" strokeOpacity="0.35" />
      {/* Clasp */}
      <rect x="118" y="70" width="34" height="22" rx="11" fill="#5446d1" stroke="#a79dff" strokeOpacity="0.4" />
      <circle cx="130" cy="81" r="4.5" fill="#d9d4ff" />
      {/* Coin in front */}
      <circle cx="66" cy="92" r="15" fill="#6d61e6" stroke="#a79dff" strokeOpacity="0.5" />
      <circle cx="66" cy="92" r="9" fill="none" stroke="#c9c3ff" strokeOpacity="0.55" strokeWidth="1.5" />
      {/* Check badge */}
      <circle cx="148" cy="106" r="15" fill="#1fa463" stroke="#0b0f1e" strokeWidth="4" />
      <path d="m141 106 5 5 9-10" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {/* Sparkles */}
      <path d="M30 84 q1.5 6 7 7 q-5.5 1-7 7 q-1.5-6-7-7 q5.5-1 7-7z" fill="#8b7eff" />
      <path d="M178 62 q1.5 6 7 7 q-5.5 1-7 7 q-1.5-6-7-7 q5.5-1 7-7z" fill="#8b7eff" />
      <circle cx="146" cy="14" r="2" fill="#8b7eff" />
      <circle cx="158" cy="34" r="1.5" fill="#8b7eff" opacity="0.7" />
      <circle cx="44" cy="58" r="1.5" fill="#8b7eff" opacity="0.6" />
    </svg>
  );
}
