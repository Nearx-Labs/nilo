// App shell: top bar, left navigation and the right-hand rail.
import { WalletButton } from "@pollar/react";
import type { ComponentType, SVGProps } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { config } from "../stellar";
import { useWallet } from "../wallet";
import {
  BoltIcon,
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

export function Topbar() {
  const { error } = useWallet();
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          <i />
          <i />
        </span>
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
  { to: "/sent", label: "Sent", Icon: HistoryIcon },
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
        <span className="icon-tile green small-tile">
          <BoltIcon width={16} height={16} />
        </span>
        <div>
          <strong>Payments agent</strong>
          <p>Builds the transaction, explains it before you sign, and keeps you in control.</p>
        </div>
      </div>
    </aside>
  );
}

export function Rail() {
  const run = useQuickAction();
  return (
    <aside className="rail">
      <div className="rail-card safe">
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
      </div>

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
