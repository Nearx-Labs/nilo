// Turns chat text into a structured send intent or price question. The model sees only what the
// user typed: no keys, no chain data, no transactions. Its output is untrusted
// and is validated again by the core before anything is built.
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { PriceQuerySchema, SendIntentSchema, type PriceQuery, type SendIntent } from "@nilo/core";
import { z } from "zod";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";

const SYSTEM = `You extract a request from a chat. You never build, sign or describe transactions, and you never state prices.

There are two kinds of request. Set "kind" accordingly.

1. kind "send": the user wants to send an amount to someone, who has a limited time to claim it. Fill:
- amount: the number exactly as written, as a decimal string with "." as separator (e.g. "50", "12.5"). Never round or convert.
- asset: the asset code to send, uppercased (e.g. "USDC", "XLM").
- fiatCurrency: only when the amount is written in money rather than in the asset, the ISO code of that money (e.g. "send R$ 50 in XLM" -> amount "50", fiatCurrency "BRL", asset "XLM"; "$10 worth of XLM" -> "USD"; "20 euros em XLM" -> "EUR"). Otherwise null. Never convert the amount yourself.
- recipient: exactly what the user wrote to identify the recipient: either a nickname (e.g. "maria") or a full Stellar address starting with G. Copy addresses character by character. Never complete, fix or invent an address.
- deadlineSeconds: how long the recipient has to claim, converted to whole seconds (e.g. "2 minutes" -> 120, "1 hour" -> 3600, "2 dias" -> 172800).

2. kind "price": the user asks what an asset or currency is worth (e.g. "how much is XLM?", "quanto está o bitcoin em reais?", "price of EUR"). Fill:
- asset: the asset or currency to price, as an uppercased ticker or ISO code (e.g. "XLM", "BTC", "ETH", "EUR"; "bitcoin" -> "BTC").
- quoteCurrency: the currency to express it in, as an ISO code; "USD" if the user did not say ("reais" -> "BRL", "euros" -> "EUR").
Leave amount, recipient, deadlineSeconds and fiatCurrency null. Never answer the price yourself; the app reads it from an on-chain oracle.

The user may write in English or Portuguese. Reply in the user's language.

If any field the request needs is missing or ambiguous, set status to "needs_clarification", put a short question in "question" asking only for what is missing, and set the unknown fields to null. Never guess a missing value.
If the message is neither a payment nor a price question, set status to "needs_clarification" and briefly say you can send claimable payments and check prices.
When everything is clear, set status to "complete" and question to null.
Use earlier messages in the conversation to fill fields the user already gave.`;

const ExtractionSchema = z.object({
  status: z.enum(["complete", "needs_clarification"]),
  kind: z.enum(["send", "price"]),
  amount: z.string().nullable(),
  asset: z.string().nullable(),
  fiatCurrency: z.string().nullable(),
  recipient: z.string().nullable(),
  deadlineSeconds: z.number().int().nullable(),
  quoteCurrency: z.string().nullable(),
  question: z.string().nullable(),
});

export const ChatSchema = z
  .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(2000) }))
  .min(1)
  .max(30)
  .refine((m) => m[0].role === "user" && m[m.length - 1].role === "user", "conversation must start and end with the user");

export type ExtractResult =
  | { status: "complete"; intent: SendIntent }
  | { status: "price"; query: PriceQuery }
  | { status: "needs_clarification"; question: string };

// Created on first use: the constructor throws when OPENAI_API_KEY is missing,
// and the server should still start (the form flow does not need the model).
let client: OpenAI | null = null;

export async function extractIntent(messages: z.infer<typeof ChatSchema>): Promise<ExtractResult> {
  client ??= new OpenAI();
  const response = await client.responses.parse({
    model: MODEL,
    instructions: SYSTEM,
    input: messages,
    text: { format: zodTextFormat(ExtractionSchema, "chat_request") },
    max_output_tokens: 1024,
  });

  const refused = response.output.some(
    (item) => item.type === "message" && item.content.some((c) => c.type === "refusal"),
  );
  if (refused) {
    return { status: "needs_clarification", question: "I can only help send claimable payments and check prices." };
  }
  const out = response.output_parsed;
  if (!out) throw new Error(`model returned no parseable output (status: ${response.status})`);

  if (out.status === "complete" && out.kind === "price") {
    const query = PriceQuerySchema.safeParse({ asset: out.asset, quoteCurrency: out.quoteCurrency ?? "USD" });
    if (query.success) return { status: "price", query: query.data };
  } else if (out.status === "complete") {
    const intent = SendIntentSchema.safeParse({ ...out, fiatCurrency: out.fiatCurrency ?? undefined });
    if (intent.success) return { status: "complete", intent: intent.data };
  }
  return {
    status: "needs_clarification",
    question: out.question ?? "Could you tell me the amount, asset, recipient and how long they have to claim?",
  };
}
