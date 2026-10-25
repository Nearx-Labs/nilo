import {
  type ResolvedIntent,
  type SendIntent,
  buildSendTx,
  mismatches,
  validateIntent,
} from "@nilo/core";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { HowItWorks } from "../components/HowItWorks";
import { ChevronIcon, CloseIcon, PlusIcon, SendIcon, WalletIcon } from "../components/icons";
import { type ChatActionState, QUICK_ACTIONS, useQuickAction } from "../components/Layout";
import { type Prepared, SignPanel } from "../components/SignPanel";
import { asSnapshot, config, loadAccount } from "../stellar";
import { formatLocal, short } from "../time";
import { useWallet } from "../wallet";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

type ExtractResponse =
  | { status: "complete"; intent: SendIntent }
  | { status: "needs_clarification"; question: string }
  | { status: "error"; message: string };

const EXAMPLE = "Send 50 TESTUSD to maria, she has 2 minutes";

const STEPS = [
  { title: "Tell me what to send", text: "In plain words, or with the form behind the + button." },
  { title: "Read before you sign", text: "The explanation is decoded from the transaction, not written by the AI." },
  { title: "Sign in your wallet", text: "If nobody claims it in time, it comes back to you." },
];

async function validateFresh(intent: SendIntent, address: string): Promise<ResolvedIntent> {
  const account = await loadAccount(address);
  if (!account) throw new Error("Your account is not on testnet yet. If you just signed in, wait a few seconds; otherwise fund it with Friendbot (Claim page).");
  const v = validateIntent(intent, asSnapshot(account), config);
  if (!v.ok) throw new Error(v.reason);
  return v.intent;
}

export function SendPage() {
  const { address, connect } = useWallet();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"chat" | "form">("chat");
  const [pending, setPending] = useState<{ intent: SendIntent; resolved: ResolvedIntent; warning?: string } | null>(
    null,
  );
  const [sent, setSent] = useState<{ deadline: number; balanceId: string } | null>(null);

  const say = (content: string) => setMessages((m) => [...m, { role: "assistant", content }]);
  const input = useRef<HTMLTextAreaElement>(null);
  const runQuick = useQuickAction();
  const location = useLocation();
  const navigate = useNavigate();

  // Quick actions (here or in the rail) arrive as router state; run once, then clear it.
  useEffect(() => {
    const state = location.state as ChatActionState | null;
    if (!state?.action) return;
    navigate(location.pathname, { replace: true, state: null });
    if (state.action === "example") {
      setMode("chat");
      setDraft(EXAMPLE);
      setTimeout(() => input.current?.focus());
    } else {
      checkBalance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  async function checkBalance() {
    setMessages((m) => [...m, { role: "user", content: "What's my balance?" }]);
    if (!address) {
      say("Sign in first (button at the top right), then I can check your balance.");
      connect();
      return;
    }
    try {
      const account = await loadAccount(address);
      if (!account) {
        say("Your account is not on testnet yet. Fund it with Friendbot on the Claim page.");
        return;
      }
      const lines = account.balances.map((b) =>
        b.asset_type === "native" ? `${b.balance} XLM` : `${b.balance} ${"asset_code" in b ? b.asset_code : "pool share"}`,
      );
      say(`Your available funds:\n${lines.map((l) => `• ${l}`).join("\n")}`);
    } catch (e) {
      say(`I couldn't load your balance: ${(e as Error).message}`);
    }
  }

  async function startReview(intent: SendIntent) {
    const from = address;
    if (!from) {
      say("Sign in first (button at the top right), then try again.");
      connect();
      return;
    }
    try {
      const resolved = await validateFresh(intent, from);
      const exists = await loadAccount(resolved.recipient);
      const warning = exists
        ? undefined
        : "This address does not exist on testnet. Nobody may be able to claim it; you can recover the funds after the deadline.";
      setSent(null);
      setPending({ intent, resolved, warning });
    } catch (e) {
      say(`I can't prepare that: ${(e as Error).message}`);
    }
  }

  async function onChat(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setDraft("");
    setBusy(true);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = (await res.json()) as ExtractResponse;
      if (data.status === "complete") {
        say(
          `Got it: ${data.intent.amount} ${data.intent.asset} to ${data.intent.recipient}, ` +
            `claimable for ${data.intent.deadlineSeconds} seconds. Checking and building the transaction…`,
        );
        await startReview(data.intent);
      } else if (data.status === "needs_clarification") {
        say(data.question);
      } else {
        say(data.message);
      }
    } catch {
      say("I couldn't reach the assistant. You can use the form instead.");
    } finally {
      setBusy(false);
    }
  }

  const prepare = useMemo(() => {
    if (!pending || !address) return null;
    return async (): Promise<Prepared> => {
      const resolved = await validateFresh(pending.intent, address);
      const account = (await loadAccount(address))!;
      const built = buildSendTx(resolved, account, config);
      return {
        xdr: built.xdr,
        check: (e) => {
          setSent({ deadline: built.deadline, balanceId: built.balanceId });
          return mismatches(e, resolved, address, built.deadline);
        },
      };
    };
  }, [pending, address]);

  function cancel() {
    setPending(null);
    setSent(null);
    say("Cancelled. Nothing was sent.");
  }

  const fresh = messages.length === 0 && !pending;

  return (
    <div className="stack chat-page page-wide">
      {fresh && (
        <>
          <header className="page-head">
            <span className="eyebrow">Chat</span>
            <h1>
              Hi! I'm <span className="accent-word">Nilo</span>
            </h1>
            <p className="muted">
              <strong className="lead">Your payments agent on Stellar.</strong> Tell me who should get what and how long
              they have. I build the transaction, explain it in plain words before you sign, and you get it back if
              nobody claims it.
            </p>
            {address && (
              <div className="row">
                <span className="connected">
                  <WalletIcon width={16} height={16} /> Connected
                </span>
                <span className="muted small">as {short(address)}</span>
              </div>
            )}
          </header>
          <div className="action-grid">
            {QUICK_ACTIONS.map((a) => (
              <button key={a.title} className="action-card" onClick={() => runQuick(a)}>
                <span className="icon-tile plain">
                  <a.Icon />
                </span>
                <span className="action-text">
                  <strong>{a.title}</strong>
                  <span>{a.hint}</span>
                </span>
                <ChevronIcon className="chevron" />
              </button>
            ))}
          </div>
          <p className="divider-label">
            <span>Or just type your request</span>
          </p>
        </>
      )}

      {messages.length > 0 && (
        <div className="chat-log">
          {messages.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              {m.content}
            </div>
          ))}
          {busy && <div className="bubble assistant muted">…</div>}
        </div>
      )}

      {mode === "chat" ? (
        <form onSubmit={onChat} className="composer">
          <textarea
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onChat();
              }
            }}
            placeholder="Who should get what, and how long do they have?"
            disabled={busy || !!pending}
            aria-label="Message"
            rows={2}
          />
          <div className="composer-bar">
            <button type="button" className="icon-button" onClick={() => setMode("form")} title="Use the form instead" aria-label="Use the form instead">
              <PlusIcon />
            </button>
            {fresh && (
              <button type="button" className="link small" onClick={() => setDraft(EXAMPLE)}>
                Try: {EXAMPLE}
              </button>
            )}
            <button className="send-button" disabled={busy || !draft.trim() || !!pending}>
              <SendIcon width={18} height={18} /> Send
            </button>
          </div>
        </form>
      ) : (
        <div className="form-wrap">
          <div className="form-head">
            <strong>New payment</strong>
            <button type="button" className="icon-button" onClick={() => setMode("chat")} title="Back to chat" aria-label="Back to chat">
              <CloseIcon />
            </button>
          </div>
          <IntentForm disabled={!!pending} onSubmit={startReview} />
        </div>
      )}

      {fresh && <HowItWorks steps={STEPS} />}

      {/* The rail lists contacts on wide screens; this copy shows when it is hidden. */}
      <p className="muted small contacts-inline">
        Contacts: {Object.keys(config.contacts).join(", ")}. Or paste a full G… address.
      </p>

      {pending && address && prepare && (
        <>
          {pending.warning && <p className="warning">{pending.warning}</p>}
          <SignPanel
            key={JSON.stringify(pending.intent)}
            prepare={prepare}
            signLabel="Sign and send"
            onCancel={cancel}
            onDone={() => say("Sent. The recipient can now claim it.")}
            doneMessage={
              sent && (
                <>
                  <p>
                    The recipient can claim it on the <Link to="/claim">Claim</Link> page until{" "}
                    {formatLocal(sent.deadline)}. After that, recover it on <Link to="/sent">Sent</Link>.
                  </p>
                  <button className="secondary" onClick={() => setPending(null)}>
                    New payment
                  </button>
                </>
              )
            }
          />
        </>
      )}
    </div>
  );
}

function IntentForm({ onSubmit, disabled }: { onSubmit: (i: SendIntent) => void; disabled: boolean }) {
  const [amount, setAmount] = useState("50");
  const [asset, setAsset] = useState(config.assets.find((a) => a.issuer)?.code ?? "XLM");
  const [recipient, setRecipient] = useState("maria");
  const [minutes, setMinutes] = useState("2");
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ amount, asset, recipient, deadlineSeconds: Math.round(Number(minutes) * 60) });
      }}
    >
      <label>
        Amount <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      </label>
      <label>
        Asset
        <select value={asset} onChange={(e) => setAsset(e.target.value)}>
          {config.assets.map((a) => (
            <option key={a.code}>{a.code}</option>
          ))}
        </select>
      </label>
      <label>
        Recipient <input value={recipient} onChange={(e) => setRecipient(e.target.value)} />
      </label>
      <label>
        Minutes to claim <input value={minutes} onChange={(e) => setMinutes(e.target.value)} inputMode="decimal" />
      </label>
      <button disabled={disabled}>Review</button>
    </form>
  );
}
