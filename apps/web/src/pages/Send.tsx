import {
  type ResolvedIntent,
  type SendIntent,
  buildSendTx,
  mismatches,
  validateIntent,
} from "@nilo/core";
import { type FormEvent, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { type Prepared, SignPanel } from "../components/SignPanel";
import { asSnapshot, config, loadAccount } from "../stellar";
import { formatLocal } from "../time";
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

  async function onChat(e: FormEvent) {
    e.preventDefault();
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

  return (
    <div className="stack">
      <div className="tabs">
        <button className={mode === "chat" ? "" : "secondary"} onClick={() => setMode("chat")}>
          Chat
        </button>
        <button className={mode === "form" ? "" : "secondary"} onClick={() => setMode("form")}>
          Form
        </button>
      </div>

      {mode === "chat" ? (
        <section className="chat">
          <div className="chat-log">
            {messages.length === 0 && (
              <p className="muted">
                Try: <button className="link" onClick={() => setDraft(EXAMPLE)}>{EXAMPLE}</button>
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`bubble ${m.role}`}>
                {m.content}
              </div>
            ))}
            {busy && <div className="bubble assistant muted">…</div>}
          </div>
          <form onSubmit={onChat} className="row">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Who should get what, and how long do they have?"
              disabled={busy || !!pending}
              aria-label="Message"
            />
            <button disabled={busy || !draft.trim() || !!pending}>Send</button>
          </form>
        </section>
      ) : (
        <>
          <IntentForm disabled={!!pending} onSubmit={startReview} />
          {messages.length > 0 && messages[messages.length - 1].role === "assistant" && (
            <p className="muted">{messages[messages.length - 1].content}</p>
          )}
        </>
      )}

      <p className="muted small">
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
