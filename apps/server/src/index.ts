import { serve } from "@hono/node-server";
import OpenAI from "openai";
import { Hono } from "hono";
import { ChatSchema, extractIntent } from "./extract";

const app = new Hono();

app.post("/api/extract", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ChatSchema.safeParse(body?.messages);
  if (!parsed.success) return c.json({ status: "error", message: "Invalid conversation." }, 400);
  try {
    return c.json(await extractIntent(parsed.data));
  } catch (e) {
    console.error("extract failed:", e);
    const message =
      !process.env.OPENAI_API_KEY || e instanceof OpenAI.AuthenticationError
        ? "The server has no valid OPENAI_API_KEY."
        : e instanceof OpenAI.RateLimitError
          ? "The assistant is rate limited. Try again in a moment."
          : "The assistant is unavailable right now.";
    return c.json({ status: "error", message }, 502);
  }
});

if (!process.env.OPENAI_API_KEY) {
  console.warn("No OPENAI_API_KEY set (see .env.example): /api/extract will fail until it is.");
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`stellar-dots server on http://localhost:${port}`));
