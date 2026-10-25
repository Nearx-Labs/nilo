import { z } from "zod";

/** What the chat agent (or the plain form) produces. Nothing here is trusted yet. */
export const SendIntentSchema = z.object({
  /** In `asset` units, or in `fiatCurrency` units when that is set. */
  amount: z.string().min(1),
  /** Asset code, e.g. "USDC" or "XLM". */
  asset: z.string().min(1),
  /** A G... address or a nickname from the fixed contact list. */
  recipient: z.string().min(1),
  deadlineSeconds: z.number().int(),
  /** Set when the user wrote the amount in money ("R$ 50 in XLM"): the app converts it with the oracle. */
  fiatCurrency: z.string().min(1).optional(),
});
export type SendIntent = z.infer<typeof SendIntentSchema>;

/** "How much is XLM in BRL?": answered from the oracle, never by the model. */
export const PriceQuerySchema = z.object({
  /** Asset or currency to price, e.g. "XLM", "BTC", "EUR". */
  asset: z.string().min(1),
  /** Currency to express it in, e.g. "USD" or "BRL". */
  quoteCurrency: z.string().min(1),
});
export type PriceQuery = z.infer<typeof PriceQuerySchema>;
