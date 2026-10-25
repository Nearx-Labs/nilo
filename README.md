# Nilo

**Stellar payments that can't get lost.** Type "send 50 USDC to maria, she has 2 minutes" and Nilo sends it as a
claimable balance. Maria can claim it before the deadline. After the deadline, only you can take it back. If you
typed the wrong address, the money comes home.

Before you sign, Nilo explains the transaction in plain English. That explanation is decoded from the transaction
itself, not written by the AI.

> HackMeridian 2026 · Stellar Unlocked track · **testnet only**

![Nilo home: chat with quick actions for sending, checking the balance, claiming and recovering](docs/screenshots/home.webp)

## Contents

- [The problem](#the-problem)
- [How a payment flows](#how-a-payment-flows)
- [The recovery rule](#the-recovery-rule)
- [Why you can trust what you sign](#why-you-can-trust-what-you-sign)
- [Prices from Reflector](#prices-from-reflector)
- [Quick start](#quick-start)
- [Try the demo](#try-the-demo)
- [Repository layout](#repository-layout)
- [Limits of v1](#limits-of-v1)
- [Next](#next)

## The problem

A crypto payment is final. One wrong character in an address and the funds are gone, with nobody to call. Chat
assistants make sending easier, which makes the risk worse: now the payment also depends on a model reading your
sentence correctly.

Nilo addresses both halves with Stellar's own primitives:

- **Every payment is recoverable by design.** It is a claimable balance with two claimants: the recipient before the
  deadline, the sender after it. No smart contract, no escrow service, no custody.
- **The AI never has the last word.** The model only turns your sentence into four fields. Everything after that is
  deterministic code you can test, and what you read before signing comes from the signed bytes.

## How a payment flows

1. **You write** "send 50 USDC to maria, she has 2 minutes".
2. **The chat agent (LLM)** turns the sentence into four fields:
   `{amount: "50", asset: "USDC", recipient: "maria", deadlineSeconds: 120}`. If a field is missing or
   ambiguous, it asks instead of guessing.
3. **Nilo validates** the intent with deterministic code: address, allowed asset, at most 7 decimals, and a balance
   that covers the amount plus the 1 XLM reserve.
4. **Nilo builds** a `createClaimableBalance` transaction (XDR).
5. **Nilo explains** it: the XDR is decoded into a fixed-template sentence and checked against what you asked for.
   You read, for example: "Sends 50 USDC to GBYY…O2ZK (maria). Claimable until 13:26 UTC, then only you can
   recover it."
6. **You sign** in your wallet (via Pollar), and the wallet submits the transaction to Stellar testnet.

The explanation step accepts only the exact shape Nilo builds. An extra operation, a third claimant, swapped
deadlines, a memo or a recovery path to someone else all produce **"Do not sign"** instead of a best-effort summary.

## The recovery rule

Each payment is one claimable balance with two time predicates that share the same instant `T`:

A payment ends in one of two ways:

- **Claimed:** the recipient claims it before `T`.
- **Recovered:** `T` passes unclaimed, and the sender claims it at or after `T`.

| Claimant | Predicate | Meaning |
|---|---|---|
| Recipient | `before_absolute_time(T)` | Can claim while the ledger time is before `T` |
| Sender | `not(before_absolute_time(T))` | Can claim from `T` on |

Two details worth knowing:

- **Trustline on claim.** If the recipient's account can't hold the asset yet, the claim transaction adds the
  trustline first: `changeTrust` + `claimClaimableBalance`, signed once, applied atomically.
- **Claiming is free for the recipient.** Nilo's sponsor account is the source of the claim transaction, so it pays
  the fee, and it sponsors the trustline's 0.5 XLM reserve with `beginSponsoringFutureReserves` /
  `endSponsoringFutureReserves`. The recipient only signs; their XLM balance does not change. If the sponsor is
  unavailable, the app falls back to a claim the recipient pays for.
- **Reserve.** While a payment is pending, 1 XLM of the sender's balance is locked (0.5 XLM per claimant). It is
  released when the balance is claimed or recovered.

Deadlines run from 60 seconds to 30 days. A built transaction stays valid for 180 seconds.

## Why you can trust what you sign

| Guarantee | How |
|---|---|
| The model never sees keys or builds transactions | It receives only the chat text (or, in voice mode, the speech) and returns a schema-validated intent. |
| On-chain data can't inject instructions into the model | The model never reads memos, asset names or anything else from the ledger. |
| The explanation matches the transaction | It is generated from the final XDR by fixed templates, then compared field by field with the validated intent. A mismatch blocks signing. |
| Nilo never holds your funds or keys | Signing happens in the user's wallet: Freighter or Albedo, or a Pollar email/Google wallet. The app only knows users' public addresses. |
| The sponsor only signs what it built | The server rebuilds each sponsored claim from the balance ID, checks on Horizon that you are the recipient and the deadline hasn't passed, then signs. It never signs XDR sent by the browser, and the explainer accepts the sponsored shape only from Nilo's own sponsor account. |

This is what you read before signing "50 USDC to maria, 2 minutes". Every line comes from the transaction bytes:

![The explanation card decoded from the XDR, with the Sign and send button](docs/screenshots/review.webp)

## Prices from Reflector

Nilo also reads live prices from [Reflector](https://reflector.network), Stellar's SEP-40 price oracle, so you can:

- **Ask for a price.** "How much is XLM in BRL?" or "quanto está o bitcoin em reais?"
- **Send in money.** "Send R$ 5 in XLM to maria, she has 2 minutes" converts reais to XLM before the review.
- **See values.** Balances and the review show an "≈ US$" value next to each amount.

The rule from payments still holds: **the model never produces a number.** It only extracts the asset, the currency and
the amount as typed. The price comes from a read-only call to the oracle contract (a simulated `lastprice`, so nothing
is signed or paid). The conversion uses bigint math and rounds down to 7 decimals, so a payment is never worth more
than you asked for. Prices older than 15 minutes are refused.

The conversion is shown on the review with its rate, oracle and time, but it is **not part of the transaction**. What
you sign is the asset amount, explained from the XDR as before.

| Reflector oracle (testnet) | Contract | Used for |
|---|---|---|
| External CEX/DEX prices, in USD | `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` | XLM, BTC, ETH, USDC… |
| Foreign exchange, in USD | `CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W` | BRL, EUR, GBP… |

## Quick start

**You need:** Node.js 20+, a [Pollar](https://pollar.xyz) testnet app and an OpenAI API key.

1. Install and create your env file:

   ```bash
   npm install
   cp .env.example .env
   ```

2. Fill in `.env`:

   | Variable | Where it comes from |
   |---|---|
   | `OPENAI_API_KEY` | OpenAI. Used only by the chat and voice endpoints; the form (the **+** button next to the chat box) works without it. |
   | `OPENAI_MODEL` | Optional. Defaults to `gpt-5.4-mini`. |
   | `OPENAI_VOICE_BACKEND_MODEL`, `OPENAI_VOICE` | Optional, for voice mode (GPT-Live, needs a paid API tier). The model that turns speech into a send or price request defaults to `OPENAI_MODEL`; the voice to `marin`. |
   | `VITE_POLLAR_API_KEY` | Pollar dashboard → Build → API Keys → **publishable** key (`pub_testnet_…`). Never use a secret key here: `VITE_*` values are shipped to the browser. |
   | `SPONSOR_SECRET` | Written for you by step 4. Testnet secret of the account that pays claim fees and trustline reserves. Server-side only. |

3. In the Pollar dashboard, add `http://localhost:5173` as an allowed origin and redirect URI, and make sure the app
   has credits for wallet creation.

4. Create the demo accounts and the sponsor account, and give alice Circle's testnet USDC from the
   [Sozu Faucet](https://faucet.sozu.capital). The demo secrets are written to `.env.demo`, and `SPONSOR_SECRET`
   to both `.env` and `.env.demo`:

   ```bash
   npm run setup:testnet
   ```

   Already set up before sponsored claims existed? Create just the sponsor, without touching the demo accounts:

   ```bash
   npm run setup:sponsor
   ```

   Set up when the demo still used TESTUSD? Give alice a USDC trustline and 100 USDC from the faucet:

   ```bash
   npm run setup:usdc
   ```

5. Check the core, then start everything:

   ```bash
   npm test        # core tests
   npm run dev     # API on :8787, web app on http://localhost:5173
   ```

## Try the demo

The demo uses the nicknames `alice` (sender), `maria` (recipient) and `bob`, all created by `setup:testnet`.

| Step | What to do | What you should see |
|---|---|---|
| 1. Send | On **Chat**, type "send 50 USDC to maria, she has 2 minutes" (or click **Send a payment** to fill it in). | An explanation card naming Maria's address and the deadline. |
| 2. Sign | Sign with your wallet. | The payment shows up as pending on **Sent**. |
| 3. Claim | As the recipient, open **Claim** before the deadline. | The explanation says Nilo's sponsor pays the fee and the trustline reserve. The balance is claimed and Maria's XLM is unchanged. |
| 4. Recover | Send to an address nobody controls, wait for the deadline, open **Sent**. | A **Recover** action that returns the funds to you. |

The **Claim** page, as the recipient sees it. It refreshes on its own, so a new payment shows up without a reload:

![Claim page: payments waiting for the recipient, an empty state and how claiming works](docs/screenshots/claim.webp)

The **Sent** page, as the sender sees it. Once a deadline passes unclaimed, the payment turns recoverable:

![Sent page: a payment nobody claimed before its deadline, with the Recover button](docs/screenshots/sent.webp)

Helper scripts:

| Command | What it does |
|---|---|
| `npx tsx scripts/smoke-testnet.ts` | End-to-end check against testnet without a wallet: send → claim with trustline, then send to a stranger → wait → recover. Needs `.env.demo`. |
| `npx tsx --env-file=.env scripts/smoke-sponsored.ts` | End-to-end check of a sponsored claim: maria (no trustline) claims while her XLM stays the same, and the server refuses a stranger and the sender. Needs `SPONSOR_SECRET`. |
| `npm run setup:sponsor` | Creates (or replaces) the sponsor account and writes `SPONSOR_SECRET`. |
| `npm run setup:usdc` | Adds alice's USDC trustline if missing and claims 100 USDC from the Sozu Faucet (it has its own cooldown). |
| `npm run demo:reset-maria` | Resets the recipient account between takes: her USDC goes back to alice and her trustline is removed. |

<details>
<summary>On a phone</summary>

<img src="docs/screenshots/mobile.webp" alt="Nilo home on a phone" width="320">

</details>

## Repository layout

| Path | What it does |
|---|---|
| [`packages/core`](packages/core) | Pure TypeScript, no UI: intent schema, validation, transaction builder, XDR explainer, predicate evaluation, price math. All the tests live here. |
| [`apps/server`](apps/server) | Four endpoints. `POST /api/extract`: chat messages in, a structured send intent, price question or clarifying question out. `POST /api/sponsor-claim`: balance ID and claimant in, a claim signed by the sponsor out. `POST /api/sponsor-trustline`: a new wallet's address in, a USDC trustline signed by the sponsor out (the reserve is the sponsor's). `POST /api/faucet`: an address in, 100 test USDC from the Sozu Faucet, rate-limited per account (1/day), per IP (3/day), per server (20/hour), one at a time, and paused while Sozu says it is out or cooling down. |
| [`apps/web`](apps/web) | Vite + React. **Chat** (send by chat or form, check balance, ask for a price), **Claim** (recipient), **Sent** (sender recovers). Login and signing through Pollar. Works on phones too. |
| [`scripts/`](scripts) | Testnet and sponsor setup, the wallet-free smoke tests, and the demo reset. |

## Limits of v1

- Testnet only. The allowed assets are XLM and Circle's testnet USDC (`GBBD47…LFLA5`).
- Recipients are a full `G…` address or a nickname from a fixed demo list (`alice`, `maria`, `bob`).
- The recipient needs an existing Stellar account. It doesn't need spare XLM: Nilo sponsors the fee and the
  trustline reserve. Sponsoring account creation (`createAccount` with a 0 starting balance) is not done yet.
- One sponsor account, with no rate limit beyond "one claim per balance". That's fine on testnet, but it would need
  limits before mainnet.
- Passkey smart wallets (`C…` addresses) are not supported: claimable balances are classic operations.

## Next

Path payments with a strict worst-case price shown before signing, so "send 50 USDC, pay in XLM" stays just as
explainable.
