import { z } from "zod";

/** What the chat agent (or the plain form) produces. Nothing here is trusted yet. */
export const SendIntentSchema = z.object({
  amount: z.string().min(1),
  /** Asset code, e.g. "TESTUSD" or "XLM". */
  asset: z.string().min(1),
  /** A G... address or a nickname from the fixed contact list. */
  recipient: z.string().min(1),
  deadlineSeconds: z.number().int(),
});
export type SendIntent = z.infer<typeof SendIntentSchema>;
