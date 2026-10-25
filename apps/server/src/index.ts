import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import OpenAI from "openai";
import { type Context, Hono } from "hono";
import { ChatSchema, extractIntent } from "./extract";
import { FaucetError, FaucetRequest, requestFaucet } from "./faucet";
import { SponsorError, SponsorRequest, sponsorClaim } from "./sponsor";
import { VoiceError, VoiceRequest, createVoiceSession } from "./voice";

const app = new Hono();

// Behind a reverse proxy every request comes from the proxy: set TRUST_PROXY=1 to use X-Forwarded-For.
// Its last entry is the one our proxy added; earlier ones come from the client and can be forged.
function clientIp(c: Context): string {
  const forwarded = process.env.TRUST_PROXY === "1" ? c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() : undefined;
  return forwarded || getConnInfo(c).remote.address || "unknown";
}

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

app.post("/api/sponsor-claim", async (c) => {
  const parsed = SponsorRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ message: "Invalid balance ID or address." }, 400);
  try {
    return c.json(await sponsorClaim(parsed.data));
  } catch (e) {
    if (e instanceof SponsorError) return c.json({ message: e.message }, e.status);
    console.error("sponsor-claim failed:", e);
    return c.json({ message: "Could not prepare a sponsored claim right now." }, 502);
  }
});

app.post("/api/faucet", async (c) => {
  const parsed = FaucetRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ message: "Invalid address." }, 400);
  try {
    return c.json(await requestFaucet(parsed.data, clientIp(c)));
  } catch (e) {
    if (e instanceof FaucetError) return c.json({ message: e.message, retryAt: e.retryAt }, e.status);
    console.error("faucet failed:", e);
    return c.json({ message: "Could not reach the test USDC faucet right now." }, 502);
  }
});

app.post("/api/voice/session", async (c) => {
  const parsed = VoiceRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ message: "Invalid voice mode request." }, 400);
  try {
    return c.json(await createVoiceSession(parsed.data));
  } catch (e) {
    if (e instanceof VoiceError) return c.json({ message: e.message }, e.status);
    console.error("voice session failed:", e);
    const message =
      e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError
        ? "The server's OpenAI key can't use voice mode."
        : e instanceof OpenAI.RateLimitError
          ? "Voice mode is rate limited. Try again in a moment."
          : "Voice mode is unavailable right now.";
    return c.json({ message }, 502);
  }
});

// In the Docker image the server also serves the built web app (STATIC_DIR, relative to the working directory).
// Unknown paths fall back to index.html so BrowserRouter routes survive a reload.
const staticDir = process.env.STATIC_DIR;
if (staticDir) {
  app.use("/*", serveStatic({ root: staticDir }));
  app.get("*", (c, next) => (c.req.path.startsWith("/api/") ? next() : serveStatic({ path: `${staticDir}/index.html` })(c, next)));
}

if (!process.env.OPENAI_API_KEY) {
  console.warn("No OPENAI_API_KEY set (see .env.example): /api/extract will fail until it is.");
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`Nilo server on http://localhost:${port}`));
