import {
  FIAT_SIGNS,
  type PriceQuery,
  type ResolvedIntent,
  type SendIntent,
  assetToFiat,
  buildSendTx,
  crossRate,
  fiatToAsset,
  formatFiat,
  formatRate,
  formatUtc,
  isFiat,
  mismatches,
  priceSymbol,
  validateIntent,
} from "@nilo/core";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ChevronIcon, CloseIcon, PlusIcon, SendIcon, SparkleIcon, WalletIcon } from "../components/icons";
import { type ChatActionState, QUICK_ACTIONS, useQuickAction } from "../components/Layout";
import { type Prepared, SignPanel } from "../components/SignPanel";
import { getQuote, shortContract } from "../prices";
import { asSnapshot, config, loadAccount } from "../stellar";
import { formatLocal, short } from "../time";
import { useWallet } from "../wallet";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

type ExtractResponse =
  | { status: "complete"; intent: SendIntent }
  | { status: "price"; query: PriceQuery }
  | { status: "needs_clarification"; question: string }
  | { status: "error"; message: string };

const EXAMPLE = "Send 50 TESTUSD to maria, she has 2 minutes";
/** Drafts the quick actions put in the composer. */
const DRAFTS = {
  example: EXAMPLE,
  price: "How much is XLM in BRL?",
  fiat: "Send R$ 5 in XLM to maria, she has 2 minutes",
};
/** Currency the "≈" values are shown in. */
const DISPLAY_FIAT = "USD";

/** How a money amount became an asset amount. Shown on review; not part of the transaction. */
interface Conversion {
  fiatAmount: string;
  currency: string;
  /** Price of one unit of the asset in `currency`, scaled by PRICE_SCALE. */
  rate: bigint;
  /** Oldest of the oracle records used, unix seconds. */
  timestamp: number;
  oracles: string[];
  /** Set when a test asset is priced as a real one. */
  pricedAs?: string;
}

/** Turns "R$ 50 in XLM" into "<n> XLM" with oracle prices. The model never does this math. */
async function convertFiat(intent: SendIntent): Promise<{ intent: SendIntent; conversion: Conversion }> {
  const currency = intent.fiatCurrency!.trim().toUpperCase();
  if (!isFiat(config, currency)) {
    throw new Error(`Payments can be written in ${config.prices!.fiat.join(", ")}, not ${currency}.`);
  }
  const symbol = priceSymbol(config, intent.asset);
  const [fiat, asset] = await Promise.all([getQuote(currency), getQuote(symbol)]);
  const amount = fiatToAsset(intent.amount, fiat, asset);
  return {
    intent: { ...intent, amount, fiatCurrency: undefined },
    conversion: {
      fiatAmount: intent.amount.trim(),
      currency,
      rate: crossRate(asset, fiat),
      timestamp: Math.min(fiat.timestamp, asset.timestamp),
      oracles: [...new Set([fiat.oracle, asset.oracle].filter(Boolean))],
      pricedAs: symbol !== intent.asset.trim().toUpperCase() ? symbol : undefined,
    },
  };
}

/** "≈ US$ 12.34", or null when there is no price for the asset (never blocks a payment). */
async function approxValue(amount: string, assetCode: string): Promise<string | null> {
  try {
    const [asset, fiat] = await Promise.all([getQuote(priceSymbol(config, assetCode)), getQuote(DISPLAY_FIAT)]);
    return `≈ ${formatFiat(assetToFiat(amount, asset, fiat), DISPLAY_FIAT)}`;
  } catch {
    return null;
  }
}

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
  const [pending, setPending] = useState<{
    intent: SendIntent;
    resolved: ResolvedIntent;
    warning?: string;
    conversion?: Conversion;
    approx?: string | null;
  } | null>(null);
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
    if (state.action === "balance") {
      checkBalance();
    } else {
      setMode("chat");
      setDraft(DRAFTS[state.action]);
      setTimeout(() => input.current?.focus());
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
      const lines = await Promise.all(
        account.balances.map(async (b) => {
          const code = b.asset_type === "native" ? "XLM" : "asset_code" in b ? b.asset_code : null;
          if (!code) return `${b.balance} pool share`;
          const approx = await approxValue(b.balance, code);
          return `${b.balance} ${code}${approx ? ` (${approx})` : ""}`;
        }),
      );
      say(
        `Your available funds:\n${lines.map((l) => `• ${l}`).join("\n")}` +
          (lines.some((l) => l.includes("≈")) ? "\n\nValues from the Reflector oracle on testnet." : ""),
      );
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
      let conversion: Conversion | undefined;
      if (intent.fiatCurrency) {
        ({ intent, conversion } = await convertFiat(intent));
        say(
          `${formatFiat(conversion.fiatAmount, conversion.currency)} is ${intent.amount} ${intent.asset.toUpperCase()} ` +
            `at ${formatRate(conversion.rate)} ${conversion.currency} per ${intent.asset.toUpperCase()} (Reflector oracle).`,
        );
      }
      const resolved = await validateFresh(intent, from);
      const [exists, approx] = await Promise.all([
        loadAccount(resolved.recipient),
        conversion ? null : approxValue(resolved.amount, resolved.asset.code),
      ]);
      const warning = exists
        ? undefined
        : "This address does not exist on testnet. Nobody may be able to claim it; you can recover the funds after the deadline.";
      setSent(null);
      setPending({ intent, resolved, warning, conversion, approx });
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
        const { amount, asset, fiatCurrency, recipient, deadlineSeconds } = data.intent;
        say(
          `Got it: ${fiatCurrency ? `${fiatCurrency} ${amount} in ${asset}` : `${amount} ${asset}`} to ${recipient}, ` +
            `claimable for ${deadlineSeconds} seconds. Checking and building the transaction…`,
        );
        await startReview(data.intent);
      } else if (data.status === "price") {
        await answerPrice(data.query);
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

  /** The answer comes from the oracle, never from the model. */
  async function answerPrice(query: PriceQuery) {
    const base = query.asset.trim().toUpperCase();
    const quote = query.quoteCurrency.trim().toUpperCase();
    try {
      const baseSymbol = priceSymbol(config, base);
      const [b, q] = await Promise.all([getQuote(baseSymbol), getQuote(quote)]);
      const sign = FIAT_SIGNS[quote];
      const value = formatRate(crossRate(b, q));
      const oracles = [...new Set([b.oracle, q.oracle].filter(Boolean))].map(shortContract).join(" + ");
      say(
        `1 ${base} = ${sign ? `${sign} ${value}` : `${value} ${quote}`}` +
          (baseSymbol !== base ? ` (priced as ${baseSymbol}; ${base} is a test asset)` : "") +
          `\nReflector oracle ${oracles} on testnet, updated ${formatUtc(Math.min(b.timestamp, q.timestamp))}.`,
      );
    } catch (e) {
      say(`I couldn't get that price: ${(e as Error).message}`);
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

  function reset() {
    setMessages([]);
    setPending(null);
    setSent(null);
    setDraft("");
    setMode("chat");
  }

  function cancel() {
    setPending(null);
    setSent(null);
    say("Cancelled. Nothing was sent.");
  }

  const fresh = messages.length === 0 && !pending;

  return (
    <div className="stack chat-page page-wide">
      <header className="page-head">
        {pending ? (
          <>
            <span className="eyebrow">Review</span>
            <h1>
              Check it, then <span className="accent-word">sign</span>
            </h1>
            <p className="muted">
              <strong className="lead">Nothing is sent until you sign.</strong> Every line below is decoded from the
              transaction itself, not written by the AI.
            </p>
          </>
        ) : (
          <>
            <span className="eyebrow">Chat</span>
            <h1>
              Hi! I'm <span className="accent-word">Nilo</span>
            </h1>
            <p className="muted">
              <strong className="lead">Your payments agent on Stellar.</strong>{" "}
              {fresh
                ? "Tell me who should get what and how long they have. I build the transaction, explain it in plain words before you sign, and you get it back if nobody claims it."
                : "Ask for another payment, check your balance, or start over."}
            </p>
          </>
        )}
        <div className="row">
          {address && (
            <>
              <span className="connected">
                <WalletIcon width={16} height={16} /> Connected
              </span>
              <span className="muted small">as {short(address)}</span>
            </>
          )}
          {!fresh && (
            <button type="button" className="secondary new-chat" onClick={reset} disabled={busy}>
              <PlusIcon width={16} height={16} /> New chat
            </button>
          )}
        </div>
      </header>

      {fresh && (
        <>
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
        <section className="panel conversation" aria-label="Conversation">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === "assistant" && (
                <span className="icon-tile violet plain msg-avatar" aria-hidden="true">
                  <SparkleIcon width={14} height={14} />
                </span>
              )}
              <div className={`bubble ${m.role}`}>{m.content}</div>
            </div>
          ))}
          {busy && (
            <div className="msg assistant">
              <span className="icon-tile violet plain msg-avatar" aria-hidden="true">
                <SparkleIcon width={14} height={14} />
              </span>
              <div className="bubble assistant muted">…</div>
            </div>
          )}
        </section>
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

      {/* The rail lists contacts on wide screens; this copy shows when it is hidden. */}
      <p className="muted small contacts-inline">
        Contacts: {Object.keys(config.contacts).join(", ")}. Or paste a full G… address.
      </p>

      {pending && address && prepare && (
        <>
          {pending.warning && <p className="warning">{pending.warning}</p>}
          {pending.conversion ? (
            <ConversionNote conversion={pending.conversion} resolved={pending.resolved} />
          ) : (
            pending.approx && (
              <p className="muted small">
                {pending.resolved.amount} {pending.resolved.asset.code} is {pending.approx} (Reflector oracle, testnet).
              </p>
            )
          )}
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

/** Where the asset amount came from. Kept apart from the decoded explanation: the transaction holds no price. */
function ConversionNote({ conversion: c, resolved }: { conversion: Conversion; resolved: ResolvedIntent }) {
  return (
    <div className="panel conversion">
      <strong>
        {formatFiat(c.fiatAmount, c.currency)} → {resolved.amount} {resolved.asset.code}
      </strong>
      <p className="small">
        Rate: 1 {resolved.asset.code} = {formatRate(c.rate)} {c.currency}
        {c.pricedAs && ` (priced as ${c.pricedAs})`}, from the Reflector oracle {c.oracles.map(shortContract).join(" + ")}{" "}
        on testnet, updated {formatUtc(c.timestamp)}. Rounded down to 7 decimals.
      </p>
      <p className="muted small">
        The conversion is not part of the transaction: what you sign is the {resolved.asset.code} amount explained below.
      </p>
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
