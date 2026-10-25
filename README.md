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

Pollar needs some dashboard setup first (domains, redirect URIs, credits): see [One-time setup](#one-time-setup).

In dev, `?watch=G…` on any page loads a public address without logging in (read-only; signing is disabled).

## Demo (3–4 min, testnet)

The pitch in one scene: a payment sent to the wrong address comes back. Everything below was run end to end on
testnet through the UI.

### One-time setup

**Pollar dashboard** (the app's testnet project):
- **Build → API Keys:** a publishable key (`pub_testnet_…`) in `.env` as `VITE_POLLAR_API_KEY`. Secret keys
  (`sec_…`) and personal tokens (`pat_…`) are refused by the browser SDK.
- **Build → Domains:** `http://localhost:5173` under **Allowed origins** *and* under **Allowed redirect URIs**
  (Google login fails with `APPLICATION_HAS_NO_REDIRECT_URIS` without the second one).
- **Billing → Credits:** a positive balance. Creating an email/Google wallet is billable; with no credits, login
  fails with `402 SDK_CREDITS_INSUFFICIENT`. Top up with Circle's test USDC (faucet.circle.com) to the app's
  Solana Devnet or Polygon Amoy deposit address.
- Wallets must be G addresses: passkey smart wallets (C…) can't create or claim claimable balances.

**Accounts** (`npm run setup:testnet` once; secrets land in `.env.demo`, never in git):

| Role | How it logs in | Holds |
|---|---|---|
| alice (sender) | Pollar → Wallet → Freighter, with `ALICE_SECRET` | TESTUSD (10 000 at setup) |
| maria (recipient) | Pollar → Wallet → Freighter, with `MARIA_SECRET`, in a second browser profile | XLM only, no trustline |

A fresh email/Google wallet also works as a sender, but it starts with XLM only: send XLM from it, not TESTUSD.

### Before each rehearsal

```bash
npm run demo:reset-maria          # maria returns her TESTUSD and drops the trustline
npm run dev                       # server :8787 + web :5173; restart after any .env change
```

Check that alice's **Sent** tab and maria's **Claim** tab are empty, and that Freighter is on **Testnet** in both
profiles.

### Script

1. **The problem (20 s).** Crypto payments are final: a typo in the address and the money is gone.

2. **Send (60 s), as alice, Chat tab:**
   ```
   Send 50 TESTUSD to maria, she has 3 minutes
   ```
   (Portuguese works too: *"Manda 50 TESTUSD pra maria, ela tem 3 minutos"*.) If a field is missing, the agent asks
   instead of guessing. Point at the green **Decoded from the transaction** card: amount, full issuer, maria's full
   address, the deadline, *"after that only you can recover"*, 1 XLM reserve. It is read from the XDR about to be
   signed, not written by the AI. **Sign and send** → approve in Freighter.

3. **Claim (45 s), as maria, second profile, Claim tab.** The payment shows as `claimable` with a countdown.
   **Claim** → the card lists two operations, *add a trustline for TESTUSD* and *claim*, in one transaction →
   **Sign and claim** → maria holds 50 TESTUSD.

4. **The wrong address (60 s), as alice:** Form tab, 25 TESTUSD, 1 minute, recipient a valid address nobody owns:
   ```
   GAFE5JH7OIU7KS7Q4DXMWWLXOTOXO6UZH4ZZLAGVFHQGSUQRETLCHINT
   ```
   The app warns that the account does not exist and still lets you send. Sign. Open **Sent**: the payment is
   `waiting` with a countdown, then turns `recoverable` at the deadline (the button waits ~5 s more for ledger
   time). **Recover** → sign → the 25 TESTUSD and the 1 XLM reserve are back.

5. **Close (20 s).** The model never touches keys or builds transactions; the explanation comes from the XDR; every
   send is recoverable by design, using only Stellar's native claimable balances.

### Timing

The deadline is fixed when the transaction is built, so time spent reviewing comes out of it: a "2 minutes"
payment signed after 20 s of talking is claimable for ~1 min 40 s. Use 3 minutes for the claim scene. The wrong-address
scene needs the full minute of waiting; fill it with the close or with the explanation card.

### If something fails on stage

- **Chat down** (no `OPENAI_API_KEY`, rate limit): use the **Form** tab; it feeds the same validation, builder and
  explainer.
- **Login or Freighter trouble:** `npx tsx scripts/smoke-testnet.ts` runs send → claim → wrong address → recover
  from the terminal with the demo keys and prints each decoded explanation (about 1 min). It leaves maria with a
  trustline, so run `npm run demo:reset-maria` afterwards.
- **Record the whole flow as a backup video** after the first good rehearsal.
