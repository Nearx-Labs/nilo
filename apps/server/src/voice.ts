// Voice mode: a GPT-Live session the browser joins over WebRTC. This server holds the key,
// creates the session and returns the SDP answer. The voice model only talks; a Responses
// backend turns what was said into calls to tools the browser runs: the text chat's send and
// price requests, plus the balance. The browser validates them again, reads prices and balances
// itself and shows the usual review: nothing is built or signed from here.
import OpenAI from "openai";
import { z } from "zod";

const BACKEND_MODEL = process.env.OPENAI_VOICE_BACKEND_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
const VOICE = process.env.OPENAI_VOICE ?? "marin";

const FRONTEND = `You are Nilo, a payments assistant on Stellar testnet, talking out loud.
Speak in the user's language (English or Portuguese), in short sentences.
For anything about sending money, prices, amounts, balances or addresses, delegate. Never say a number, price, address or result you did not get back from the backend.
When the backend says a review is on screen, tell the user to check it and sign there. You cannot sign or send anything yourself.
Never read a full Stellar address aloud; say its first and last four characters.`;

const BACKEND = `You turn a spoken request into one of three tool calls. You never build, sign or describe transactions, and you never state prices or balances yourself.

- prepare_send: the user wants to send an amount to someone, who has a limited time to claim it.
- get_price: the user asks what an asset or currency is worth.
- get_balance: the user asks how much they have ("qual é meu saldo?", "what's my balance?").

Speech transcripts can be imperfect. Use earlier turns to fill fields the user already gave. If a field is missing or unclear, ask a short question for only that field instead of calling a tool. Never guess a missing value.
If the request is none of these, say briefly that you can send claimable payments, check prices and check the balance.
After a tool returns, pass on what it says in one or two sentences. Say amounts the way the tool gives them, rounded, and prefer the money value; never read a long decimal digit by digit. The exact amounts are on screen. If it says a review is on screen, ask the user to check it and sign there.`;

const TOOLS = [
  {
    type: "function" as const,
    name: "prepare_send",
    description: "Show the user a payment to review and sign. The app checks the balance and the recipient first.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["amount", "asset", "fiatCurrency", "recipient", "deadlineSeconds"],
      properties: {
        amount: { type: "string", description: 'The number as said, as a decimal string with "." (e.g. "50", "12.5"). Never round or convert.' },
        asset: { type: "string", description: 'Asset code to send, uppercased (e.g. "USDC", "XLM").' },
        fiatCurrency: {
          type: ["string", "null"],
          description: 'Only when the amount is said in money rather than in the asset: its ISO code ("50 reais in XLM" -> "BRL"). Otherwise null.',
        },
        recipient: { type: "string", description: 'A contact nickname (e.g. "maria") or a full Stellar address starting with G, exactly as given.' },
        deadlineSeconds: { type: "integer", description: 'How long the recipient has to claim, in whole seconds ("2 minutes" -> 120).' },
      },
    },
  },
  {
    type: "function" as const,
    name: "get_balance",
    description: "Read the user's own balances on testnet, with approximate values from the oracle.",
    strict: true,
    parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
  {
    type: "function" as const,
    name: "get_price",
    description: "Read the price of an asset or currency from the on-chain oracle.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["asset", "quoteCurrency"],
      properties: {
        asset: { type: "string", description: 'Uppercased ticker or ISO code ("bitcoin" -> "BTC", "EUR").' },
        quoteCurrency: { type: "string", description: 'ISO code to express it in ("reais" -> "BRL"); "USD" if not said.' },
      },
    },
  },
];

export const VoiceRequest = z.object({ sdp: z.string().min(1).max(20_000) });

export class VoiceError extends Error {
  constructor(
    message: string,
    readonly status: 429 | 502 | 503,
  ) {
    super(message);
  }
}

const HOUR = 60 * 60_000;
export const LIMITS = {
  /** Sessions per client IP per hour. */
  perIp: 5,
  /** Sessions for the whole server per hour. */
  perHour: 60,
};

/** Client IP → session start times in the last hour. */
const byIp = new Map<string, number[]>();
let recent: number[] = [];

function prune(now: number) {
  for (const [ip, times] of byIp) {
    const kept = times.filter((t) => t > now - HOUR);
    if (kept.length) byIp.set(ip, kept);
    else byIp.delete(ip);
  }
  recent = recent.filter((t) => t > now - HOUR);
}

let client: OpenAI | null = null;

export async function createVoiceSession(req: z.infer<typeof VoiceRequest>, ip: string): Promise<{ sdp: string; sessionId: string }> {
  if (!process.env.OPENAI_API_KEY) throw new VoiceError("The server has no OPENAI_API_KEY.", 503);
  const now = Date.now();
  prune(now);
  const ipTimes = byIp.get(ip) ?? [];
  if (ipTimes.length >= LIMITS.perIp) throw new VoiceError("Too many voice sessions from your network this hour.", 429);
  if (recent.length >= LIMITS.perHour) throw new VoiceError("Voice mode is busy this hour.", 429);
  byIp.set(ip, [...ipTimes, now]);
  recent.push(now);

  client ??= new OpenAI({ maxRetries: 0 });
  const live = await client.live.create({
    session: {
      model: "gpt-live-1",
      instructions: FRONTEND,
      audio: { output: { voice: VOICE } },
      delegation: {
        type: "responses",
        responses: { model: BACKEND_MODEL, instructions: BACKEND, tools: TOOLS, tool_choice: "auto", parallel_tool_calls: false },
      },
      // The browser is untrusted: it may return tool results and hang up, not change the prompts or the backend.
      client: { data_channel: { allowed_client_events: ["response.item.create", "response.create", "session.close"] } },
    },
    transport: { type: "webrtc", sdp: req.sdp },
  });
  return { sdp: live.transport.sdp, sessionId: live.session.id };
}
