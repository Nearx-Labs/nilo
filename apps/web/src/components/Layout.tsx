// App shell: top bar, left navigation and the right-hand rail.
import { WalletButton } from "@pollar/react";
import type { ComponentType, SVGProps } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { config } from "../stellar";
import { useWallet } from "../wallet";
import {
  ChatIcon,
  ChevronIcon,
  HistoryIcon,
  InboxIcon,
  SendIcon,
  ShieldIcon,
  SparkleIcon,
  WalletIcon,
} from "./icons";

/** Chat actions the Send page runs when it is opened with this router state. */
export type ChatAction = "example" | "balance";
export interface ChatActionState {
  action: ChatAction;
  /** Makes a repeated click a new navigation. */
  at: number;
}

export interface QuickAction {
  title: string;
  hint: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone: "violet" | "blue" | "green" | "purple";
  to: string;
  action?: ChatAction;
}

export const QUICK_ACTIONS: QuickAction[] = [
  { title: "Send a payment", hint: "To a contact or any G… address", Icon: SendIcon, tone: "violet", to: "/send", action: "example" },
  { title: "Check balance", hint: "View your available funds", Icon: WalletIcon, tone: "blue", to: "/send", action: "balance" },
  { title: "Claim a payment", hint: "See what's waiting for you", Icon: InboxIcon, tone: "green", to: "/claim" },
  { title: "Sent payments", hint: "Track or recover what you sent", Icon: HistoryIcon, tone: "purple", to: "/sent" },
];

export function useQuickAction() {
  const navigate = useNavigate();
  return (a: QuickAction) =>
    navigate(a.to, a.action ? { state: { action: a.action, at: Date.now() } satisfies ChatActionState } : undefined);
}

/** README section that explains why the decoded explanation can be trusted. */
const TRUST_URL = "https://github.com/Nearx-Labs/nilo#why-you-can-trust-what-you-sign";

/** Nilo's mark: a rounded "N" on a dark violet disc. */
function LogoMark() {
  return (
    <svg className="logo" viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
      <defs>
        <linearGradient id="logo-n" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c7c2ff" />
          <stop offset="1" stopColor="#7b6cff" />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="20" fill="#1c1f45" />
      <path
        d="M12.5 26V15.5a3.2 3.2 0 0 1 5.9-1.7l3.2 5.2 3.2 5.2a3.2 3.2 0 0 0 5.9-1.7V14"
        fill="none"
        stroke="url(#logo-n)"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Topbar() {
  const { error } = useWallet();
  return (
    <header className="topbar">
      <div className="brand">
        <LogoMark />
        <span className="brand-name">Nilo</span>
        <span className="tag">Payments agent</span>
      </div>
      <div className="topbar-right">
        <span className="status">
          <i className="dot" /> Testnet
        </span>
        <div className="wallet-chip">
          <WalletButton />
        </div>
        {error && <span className="error small wallet-error">{error}</span>}
      </div>
    </header>
  );
}

const NAV = [
  { to: "/send", label: "Chat", Icon: ChatIcon },
  { to: "/claim", label: "Claim", Icon: InboxIcon },
  { to: "/sent", label: "Sent", Icon: SendIcon },
];

export function Sidebar() {
  return (
    <aside className="sidebar">
      <nav className="nav">
        {NAV.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} className="nav-item">
            <Icon /> {label}
          </NavLink>
        ))}
      </nav>
      <div className="agent-card">
        <span className="icon-tile green">
          <ShieldIcon />
        </span>
        <div>
          <strong>Payments agent</strong>
          <p>Secure, autonomous and always on your side.</p>
        </div>
      </div>
    </aside>
  );
}

export function Rail() {
  const run = useQuickAction();
  return (
    <aside className="rail">
      <a className="rail-card safe" href={TRUST_URL} target="_blank" rel="noreferrer">
        <span className="icon-tile green">
          <ShieldIcon />
        </span>
        <div>
          <strong>Safe by design</strong>
          <p>
            Every transaction is decoded from its XDR and explained before you sign. Unclaimed funds come back to you
            after the deadline.
          </p>
        </div>
        <ChevronIcon className="chevron" />
      </a>

      <div className="rail-card list">
        <h3>Quick actions</h3>
        {QUICK_ACTIONS.map((a) => (
          <button key={a.title} className="rail-action" onClick={() => run(a)}>
            <span className={`icon-tile ${a.tone}`}>
              <a.Icon />
            </span>
            <span className="rail-action-text">
              <strong>{a.title}</strong>
              <span>{a.hint}</span>
            </span>
            <ChevronIcon className="chevron" />
          </button>
        ))}
      </div>

      <div className="rail-card">
        <span className="icon-tile violet plain">
          <SparkleIcon />
        </span>
        <div>
          <strong>Need something else?</strong>
          <p>Just tell me who should get what, in plain language. I'm here to help.</p>
          <p className="contacts">
            Contacts: {Object.keys(config.contacts).join(", ")}. Or paste a full G… address.
          </p>
        </div>
      </div>
    </aside>
  );
}
