import {
  FIAT_SIGNS,
  STROOPS_PER_UNIT,
  type PriceQuery,
  PriceQuerySchema,
  type ResolvedIntent,
  type SendIntent,
  SendIntentSchema,
  assetToFiat,
  buildSendTx,
  crossRate,
  fiatToAsset,
  formatFiat,
  formatRate,
  formatScaled,
  formatUtc,
  fromStroops,
  isFiat,
  mismatches,
  priceSymbol,
  toStroops,
  validateIntent,
} from "@nilo/core";
import { type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { type Bot, type ChatMessage, DEFAULT_BOT, loadChat, useBots } from "../bots/store";
import { StroopyAvatar } from "../bots/StroopyAvatar";
import {
  ArrowUpIcon,
  CloseIcon,
  EraseIcon,
  MicIcon,
  MoreIcon,
  PlusIcon,
  ShieldIcon,
  TrashIcon,
  WalletIcon,
  WaveformIcon,
} from "../components/icons";
import { type ChatActionState, MoreMenu, PageTop, QUICK_ACTIONS, TRUST_URL, useQuickAction } from "../components/Layout";
import { type Prepared, SignPanel } from "../components/SignPanel";
import { VoiceBar } from "../components/VoiceBar";
import { getQuote, shortContract } from "../prices";
import { asSnapshot, config, loadAccount } from "../stellar";
import { formatLocal } from "../time";
import { useVoiceSession } from "../voice";
import { SETUP_TEXT, useAccountSetup, useWallet } from "../wallet";

type ExtractResponse =
  | { status: "complete"; intent: SendIntent }
  | { status: "price"; query: PriceQuery }
  | { status: "needs_clarification"; question: string }
  | { status: "error"; message: string };

const EXAMPLE = "Send 50 USDC to maria, she has 2 minutes";
const VOICE_LABEL = {
  idle: "Voice mode",
  connecting: "Connecting voice mode… (tap to cancel)",
  live: "End voice mode",
  closing: "Ending voice mode…",
} as const;
/** Pixels from the bottom that still count as "following" the conversation. */
const STICK_PX = 80;

const CHECKING = "Checking and building the transaction…";
const DONE = "Sent. The recipient can now claim it.";
const CANCELLED = "Cancelled. Nothing was sent.";
const INTERRUPTED = "That review was closed. If you didn't sign it, nothing was sent.";
const ENDINGS = [DONE, CANCELLED, INTERRUPTED];

/** A saved chat can end mid-review (reload, other bot); the sign panel is not saved, so say so. */
function loadSettled(botId: string): ChatMessage[] {
  const saved = loadChat(botId);
  return saved[saved.length - 1]?.content.endsWith(CHECKING) ? [...saved, { role: "assistant", content: INTERRUPTED }] : saved;
}

/** What /api/extract gets: the turns since the last finished payment, within the server's limits (≤ 30, user first). */
function forExtract(messages: ChatMessage[]): ChatMessage[] {
  let from = messages.length;
  while (from > 0 && !(messages[from - 1].role === "assistant" && ENDINGS.includes(messages[from - 1].content))) from--;
  const turns = messages
    .slice(from)
    .slice(-30)
    .map((m) => ({ ...m, content: m.content.slice(0, 2000) }))
    .filter((m) => m.content.trim());
  const start = turns.findIndex((m) => m.role === "user");
  return start < 0 ? [] : turns.slice(start);
}

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

/** Value in DISPLAY_FIAT as a 7-decimal amount, or null when there is no price for the asset. */
async function fiatValue(amount: string, assetCode: string): Promise<string | null> {
  try {
    const [asset, fiat] = await Promise.all([getQuote(priceSymbol(config, assetCode)), getQuote(DISPLAY_FIAT)]);
    return assetToFiat(amount, asset, fiat);
  } catch {
    return null;
  }
}

/** "≈ US$ 12.34", or null when there is no price for the asset (never blocks a payment). */
async function approxValue(amount: string, assetCode: string): Promise<string | null> {
  const value = await fiatValue(amount, assetCode);
  return value === null ? null : `≈ ${formatFiat(value, DISPLAY_FIAT)}`;
}

/** An amount rounded for speech ("9999.9999900" -> "10,000"); the exact one stays on screen. */
function spokenAmount(amount: string): string {
  const stroops = toStroops(amount);
  const digits = stroops >= 100n * STROOPS_PER_UNIT ? 0 : stroops >= STROOPS_PER_UNIT ? 2 : 4;
  const text = formatScaled(stroops, STROOPS_PER_UNIT, digits);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

async function validateFresh(intent: SendIntent, address: string): Promise<ResolvedIntent> {
  const account = await loadAccount(address);
  if (!account) throw new Error("Your account is not on testnet yet. If you just signed in, wait a few seconds; otherwise fund it with Friendbot (Claim page).");
  const v = validateIntent(intent, asSnapshot(account), config);
  if (!v.ok) {
    const lowUsdc = /^(Your account holds no|Insufficient) USDC\b/.test(v.reason);
    throw new Error(lowUsdc ? `${v.reason} Get free test USDC on the Claim page.` : v.reason);
  }
  return v.intent;
}

export function ChatPage({ bot }: { bot: Bot }) {
  const { address, connect, error: walletError, notReady } = useWallet();
  const setup = useAccountSetup(address);
  const { saveChat, deleteBot } = useBots();
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadSettled(bot.id));
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
  const fresh = messages.length === 0 && !pending;
  // The welcome screen reads from the top; only a conversation (or the form) follows the bottom.
  const idle = fresh && mode === "chat";

  /** While a voice tool call runs, what the app says is also its result, spoken back. */
  const voiceOut = useRef<string[] | null>(null);
  /** `spoken` replaces `content` in voice mode when the text doesn't read well aloud (long decimals). */
  const say = (content: string, spoken = content) => {
    voiceOut.current?.push(spoken);
    setMessages((m) => [...m, { role: "assistant", content }]);
  };
  const voice = useVoiceSession({
    onToolCall: runVoiceTool,
    onTranscript: (role, content) => setMessages((m) => [...m, { role, content }]),
    onError: say,
  });
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  const stick = useRef(!idle);
  const request = useRef<AbortController | null>(null);
  const chatPath = `/chat/${bot.id}`;
  const runQuick = useQuickAction(chatPath);
  const location = useLocation();
  const navigate = useNavigate();

  // A question still waiting for its reply is not saved: leaving the bot drops the request.
  useEffect(() => {
    const unanswered = busy && messages[messages.length - 1]?.role === "user";
    saveChat(bot.id, unanswered ? messages.slice(0, -1) : messages);
  }, [bot.id, messages, busy, saveChat]);
  useEffect(() => () => request.current?.abort(), []);

  // Quick actions arrive as router state; run once, then clear it.
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

  // Follow the conversation as it grows (new messages, the sign panel building), unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current;
    const content = flow.current;
    if (!el || !content) return;
    const onScroll = () => (stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX);
    const ro = new ResizeObserver(() => stick.current && el.scrollTo({ top: el.scrollHeight }));
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(content);
    if (stick.current) el.scrollTo({ top: el.scrollHeight });
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    stick.current = !idle;
    scroller.current?.scrollTo({ top: idle ? 0 : scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, busy, mode, pending, idle]);

  // Grow the composer with its text, up to six lines.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 6 * 22 + 22)}px`;
  }, [draft, voice.state]);

  /** From the menu or a quick action: shows the question it answers. Voice already has the user's words. */
  function checkBalance() {
    setMessages((m) => [...m, { role: "user", content: "What's my balance?" }]);
    return answerBalance();
  }

  async function answerBalance() {
    if (!address) {
      say(walletError ?? "Sign in first (the button at the bottom of the sidebar), then I can check your balance.");
      connect();
      return;
    }
    if (notReady) {
      say(notReady);
      return;
    }
    if (setup === "account" || setup === "trustline") {
      say(SETUP_TEXT[setup]);
      return;
    }
    try {
      const account = await loadAccount(address);
      if (!account) {
        say("Your account is not on testnet yet. Fund it with Friendbot on the Claim page.");
        return;
      }
      const rows = await Promise.all(
        account.balances.map(async (b) => {
          const code = b.asset_type === "native" ? "XLM" : "asset_code" in b ? b.asset_code : null;
          if (!code) return { line: `${b.balance} pool share`, spoken: null, value: null };
          const value = await fiatValue(b.balance, code);
          const money = value && formatFiat(value, DISPLAY_FIAT);
          return {
            line: `${b.balance} ${code}${money ? ` (≈ ${money})` : ""}`,
            // Aloud, money is easier to follow than token units; units only when there is no price.
            spoken: money ? `${money} in ${code}` : `about ${spokenAmount(b.balance)} ${code}`,
            value,
          };
        }),
      );
      const values = rows.flatMap((r) => (r.value ? [toStroops(r.value)] : []));
      const total = values.length > 1 && formatFiat(fromStroops(values.reduce((a, b) => a + b)), DISPLAY_FIAT);
      const usdcNote = setup === "usdc" ? `\n\n${SETUP_TEXT.usdc}` : "";
      say(
        `Your available funds:\n${rows.map((r) => `• ${r.line}`).join("\n")}` +
          (values.length ? "\n\nValues from the Reflector oracle on testnet." : "") +
          usdcNote,
        `The user has ${rows.flatMap((r) => r.spoken ?? []).join(", and ")}.` +
          (total ? ` In total about ${total}.` : "") +
          " The exact amounts are on screen." +
          usdcNote,
      );
    } catch (e) {
      say(`I couldn't load your balance: ${(e as Error).message}`);
    }
  }

  /** True when the review is on screen. */
  async function startReview(intent: SendIntent): Promise<boolean> {
    const from = address;
    if (!from) {
      say(walletError ?? "Sign in first (the button at the bottom of the sidebar), then try again.");
      connect();
      return false;
    }
    if (notReady) {
      say(notReady);
      return false;
    }
    if (setup) {
      say(SETUP_TEXT[setup]);
      return false;
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
      return true;
    } catch (e) {
      say(`I can't prepare that: ${(e as Error).message}`);
      return false;
    }
  }

  /** A tool the voice backend asked for. Its arguments are untrusted, like /api/extract's output. */
  async function runVoiceTool(name: string, args: unknown): Promise<string> {
    voiceOut.current = [];
    try {
      if (name === "get_balance") {
        await answerBalance();
      } else if (name === "get_price") {
        const query = PriceQuerySchema.safeParse(args);
        if (!query.success) return "That price request was incomplete.";
        await answerPrice(query.data);
      } else if (name === "prepare_send") {
        const raw = (args ?? {}) as Record<string, unknown>;
        const intent = SendIntentSchema.safeParse({ ...raw, fiatCurrency: raw.fiatCurrency ?? undefined });
        if (!intent.success) return "That payment request was incomplete.";
        if (await startReview(intent.data)) {
          voiceOut.current.push("The review is on screen. Nothing is sent until the user checks it and taps Sign and send.");
        }
      } else {
        return `There is no tool called ${name}.`;
      }
      return voiceOut.current.join("\n");
    } finally {
      voiceOut.current = null;
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
    // The send button is swapped out once the draft clears; keep the keyboard in the composer.
    input.current?.focus();
    const ctrl = new AbortController();
    request.current = ctrl;
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: forExtract(next) }),
        signal: ctrl.signal,
      });
      const data = (await res.json()) as ExtractResponse;
      if (data.status === "complete") {
        const { amount, asset, fiatCurrency, recipient, deadlineSeconds } = data.intent;
        say(
          `Got it: ${fiatCurrency ? `${fiatCurrency} ${amount} in ${asset}` : `${amount} ${asset}`} to ${recipient}, ` +
            `claimable for ${deadlineSeconds} seconds. ${CHECKING}`,
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
      if (!ctrl.signal.aborted) say("I couldn't reach the assistant. You can use the form instead.");
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
    say(CANCELLED);
  }

  function fillExample() {
    setMode("chat");
    setDraft(EXAMPLE);
    input.current?.focus();
  }

  const hasText = draft.trim().length > 0;
  const deletable = bot.id !== DEFAULT_BOT.id;

  return (
    <div className="view">
      <PageTop
        avatar={<StroopyAvatar variant={bot.variant} color={bot.color} size={28} />}
        title={bot.name}
        actions={
          <MoreMenu label="Chat options" trigger={<MoreIcon />}>
            {(close) => (
              <>
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => {
                    close();
                    reset();
                  }}
                >
                  <EraseIcon width={18} height={18} /> Clear chat
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy || !!pending}
                  onClick={() => {
                    close();
                    checkBalance();
                  }}
                >
                  <WalletIcon width={18} height={18} /> Check balance
                </button>
                {deletable && (
                  <button
                    type="button"
                    role="menuitem"
                    className="danger"
                    onClick={() => {
                      close();
                      if (!window.confirm(`Delete ${bot.name}? Its chat history is deleted too.`)) return;
                      navigate(`/chat/${DEFAULT_BOT.id}`);
                      deleteBot(bot.id);
                    }}
                  >
                    <TrashIcon width={18} height={18} /> Delete bot
                  </button>
                )}
              </>
            )}
          </MoreMenu>
        }
      />

      <div className="view-scroll" ref={scroller}>
        <div className="flow" ref={flow} role="log" aria-label="Conversation">
          {fresh && (
            <section className="hero">
              <StroopyAvatar variant={bot.variant} color={bot.color} size={96} />
              <h1>Hi! I'm {bot.name}</h1>
              <p className="hero-sub">
                <strong>Your payments agent on Stellar.</strong> Tell me who should get what and how long they have. I
                build the transaction, explain it in plain words before you sign, and you get it back if nobody claims it.
              </p>
              <div className="suggestions">
                {QUICK_ACTIONS.map((a) => (
                  <button key={a.title} type="button" className="suggestion" title={a.hint} onClick={() => runQuick(a)}>
                    <a.Icon className={`tone-${a.tone}`} />
                    {a.title}
                  </button>
                ))}
              </div>
              <button type="button" className="suggestion try" onClick={fillExample}>
                Try: {EXAMPLE}
              </button>
              <p className="muted small">
                Contacts: {Object.keys(config.contacts).join(", ")}. Or paste a full G… address.
              </p>
              <a className="safe-note" href={TRUST_URL} target="_blank" rel="noreferrer">
                <ShieldIcon width={16} height={16} />
                Safe by design: every transaction is decoded and explained before you sign.
              </a>
            </section>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className={`bubble ${m.role}`}>{m.content}</div>
            </div>
          ))}
          {busy && (
            <div className="msg assistant">
              <div className="bubble assistant typing" role="status">
                <span className="sr-only">{bot.name} is typing…</span>
                <i aria-hidden="true" />
                <i aria-hidden="true" />
                <i aria-hidden="true" />
              </div>
            </div>
          )}

          {mode === "form" && (
            <div className="msg assistant wide">
              <section className="panel form-card">
                <div className="form-head">
                  <strong>New payment</strong>
                  <button type="button" className="icon-btn ghost small-btn" onClick={() => setMode("chat")} title="Back to chat" aria-label="Back to chat">
                    <CloseIcon width={18} height={18} />
                  </button>
                </div>
                <IntentForm disabled={!!pending} onSubmit={startReview} />
              </section>
            </div>
          )}

          {pending && address && prepare && (
            <div className="msg assistant wide">
              <p className="review-note">
                <strong>Check it, then sign.</strong> Nothing is sent until you sign. Every line below is decoded from
                the transaction itself, not written by the AI.
              </p>
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
                onDone={() => say(DONE)}
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
            </div>
          )}
        </div>
      </div>

      <div className="composer-wrap">
        <form onSubmit={onChat} className="composer">
          <button
            type="button"
            className={`icon-btn${mode === "form" ? " on" : ""}`}
            onClick={() => setMode((m) => (m === "form" ? "chat" : "form"))}
            title={mode === "form" ? "Back to chat" : "Use the form instead"}
            aria-label={mode === "form" ? "Back to chat" : "Use the form instead"}
            aria-pressed={mode === "form"}
          >
            <PlusIcon />
          </button>
          {voice.state !== "idle" ? (
            <VoiceBar state={voice.state} levels={voice.levels} name={bot.name} />
          ) : (
            <>
              <textarea
                ref={input}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
                  // Enter also confirms an IME candidate; only send once composition is over.
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                    e.preventDefault();
                    onChat();
                  }
                }}
                placeholder={`Message ${bot.name}`}
                readOnly={busy}
                disabled={!!pending}
                aria-label="Message"
                rows={1}
              />
              <button
                type="button"
                className="icon-btn ghost voice"
                disabled
                aria-disabled="true"
                title="Voice input — coming soon"
                aria-label="Voice input — coming soon"
              >
                <MicIcon />
              </button>
            </>
          )}
          {hasText && voice.state === "idle" ? (
            <button type="submit" className="round-send" disabled={busy || !!pending} aria-label="Send" title="Send">
              <ArrowUpIcon />
            </button>
          ) : (
            <button
              type="button"
              className={`round-send voice ${voice.state}`}
              onClick={voice.state === "idle" ? voice.start : voice.stop}
              disabled={voice.state === "closing"}
              aria-pressed={voice.state !== "idle"}
              title={VOICE_LABEL[voice.state]}
              aria-label={VOICE_LABEL[voice.state]}
            >
              <WaveformIcon />
            </button>
          )}
        </form>
      </div>
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
