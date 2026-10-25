# stellar-dots

Chat-driven Stellar payments that can't get lost. "Send 50 TESTUSD to maria, she has 2 minutes" becomes a
**claimable balance**: the recipient can claim it before the deadline; after it, only the sender can recover it.
Before signing, the app explains the transaction **decoded from its XDR** with fixed templates. The AI never sees
keys, never builds transactions and never writes the explanation.

HackMeridian 2026 · Stellar Unlocked · testnet only.

## Layout

| Path | What |
|---|---|
| `packages/core` | Pure TS: intent schema, validation, transaction builder, XDR explainer, predicate evaluation. Tests here. |
| `apps/server` | Hono, one endpoint `POST /api/extract`: chat → `{amount, asset, recipient, deadlineSeconds}` via OpenAI (`gpt-5.4-mini` by default, `OPENAI_MODEL` to change). |
| `apps/web` | Vite + React. `/send` (chat or form), `/claim` (recipient), `/sent` (sender recovers). Login and signing through [Pollar](https://pollar.xyz): Freighter/Albedo or an email/Google wallet. |
| `scripts/setup-testnet.ts` | Creates issuer + TESTUSD, funds alice/maria/bob via Friendbot, writes `packages/core/src/demo.json` and `.env.demo` (secrets). |
| `scripts/reset-maria.ts` | `npm run demo:reset-maria`: maria returns her TESTUSD and drops the trustline, so the next claim shows `changeTrust + claim`. |
| `scripts/smoke-testnet.ts` | Full flow on testnet without a wallet: send → claim (+trustline), send to a stranger → wait → recover. |

## Run

```bash
npm install
cp .env.example .env              # set OPENAI_API_KEY and VITE_POLLAR_API_KEY
npm run setup:testnet             # fresh demo accounts (secrets in .env.demo)
npm test                          # core tests
npm run dev                       # server :8787 + web :5173 (proxies /api)
```

The **Form** tab on `/send` skips the AI entirely and feeds the same validation, builder and explainer.

In the Pollar dashboard, allow `http://localhost:5173` under Build → Domains, use G-address wallets (passkey smart
wallets can't do claimable balances), and enable sponsorship if recipients should get trustlines without XLM.

In dev, `?watch=G…` on any page loads a public address without logging in (read-only; signing is disabled).

## Demo checklist

1. Before each rehearsal: `npm run demo:reset-maria` (maria must have **no** TESTUSD trustline so the claim shows `changeTrust + claim`). For brand-new accounts instead, `npm run setup:testnet` and re-import the keys into Freighter.
2. Send 50 TESTUSD to maria with 2 minutes; show the decoded explanation; sign.
3. Log in as maria (another browser profile, or her email wallet) → `/claim` → claim.
4. Send to a wrong (random) address with 1 minute → wait → `/sent` → recover.
5. Record the full flow as a backup video before polishing.
