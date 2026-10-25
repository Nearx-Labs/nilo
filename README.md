# Nilo

**Stellar payments that can't get lost.** Type "send 50 TESTUSD to maria, she has 2 minutes" and Nilo sends it as a
claimable balance. Maria can claim it before the deadline. After the deadline, only you can take it back. If you
typed the wrong address, the money comes home.

Before you sign, Nilo explains the transaction in plain English. That explanation is decoded from the transaction
itself, not written by the AI.

> HackMeridian 2026 · Stellar Unlocked track · **testnet only**

## Contents

- [The problem](#the-problem)
- [How a payment flows](#how-a-payment-flows)
- [The recovery rule](#the-recovery-rule)
- [Why you can trust what you sign](#why-you-can-trust-what-you-sign)
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

1. **You write** "send 50 TESTUSD to maria, she has 2 minutes".
2. **The chat agent (LLM)** turns the sentence into four fields:
   `{amount: "50", asset: "TESTUSD", recipient: "maria", deadlineSeconds: 120}`. If a field is missing or
   ambiguous, it asks instead of guessing.
3. **Nilo validates** the intent with deterministic code: address, allowed asset, at most 7 decimals, and a balance
   that covers the amount plus the 1 XLM reserve.
4. **Nilo builds** a `createClaimableBalance` transaction (XDR).
5. **Nilo explains** it: the XDR is decoded into a fixed-template sentence and checked against what you asked for.
   You read, for example: "Sends 50 TESTUSD to GBYY…O2ZK (maria). Claimable until 13:26 UTC, then only you can
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
- **Reserve.** While a payment is pending, 1 XLM of the sender's balance is locked (0.5 XLM per claimant). It is
  released when the balance is claimed or recovered.

Deadlines run from 60 seconds to 30 days. A built transaction stays valid for 180 seconds.

## Why you can trust what you sign

| Guarantee | How |
|---|---|
| The model never sees keys or builds transactions | It receives only the chat text and returns a schema-validated JSON intent. |
| On-chain data can't inject instructions into the model | The model never reads memos, asset names or anything else from the ledger. |
| The explanation matches the transaction | It is generated from the final XDR by fixed templates, then compared field by field with the validated intent. A mismatch blocks signing. |
| Nilo never holds funds or keys | Signing happens in the user's wallet: Freighter or Albedo, or a Pollar email/Google wallet. The app only knows public addresses. |

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
   | `OPENAI_API_KEY` | OpenAI. Used only by the chat endpoint; the **Form** tab works without it. |
   | `OPENAI_MODEL` | Optional. Defaults to `gpt-5.4-mini`. |
   | `VITE_POLLAR_API_KEY` | Pollar dashboard → Build → API Keys → **publishable** key (`pub_testnet_…`). Never use a secret key here: `VITE_*` values are shipped to the browser. |

3. In the Pollar dashboard, add `http://localhost:5173` as an allowed origin and redirect URI, and make sure the app
   has credits for wallet creation.

4. Create TESTUSD and the demo accounts. Their secrets are written to `.env.demo`:

   ```bash
   npm run setup:testnet
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
| 1. Send | On **Send**, type "send 50 TESTUSD to maria, she has 2 minutes". | An explanation card naming Maria's address and the deadline. |
| 2. Sign | Sign with your wallet. | The payment shows up as pending on **Sent**. |
| 3. Claim | As the recipient, open **Claim** before the deadline. | The balance is claimed, with the trustline added if needed. |
| 4. Recover | Send to an address nobody controls, wait for the deadline, open **Sent**. | A **Recover** action that returns the funds to you. |

Helper scripts:

| Command | What it does |
|---|---|
| `npx tsx scripts/smoke-testnet.ts` | End-to-end check against testnet without a wallet: send → claim with trustline, then send to a stranger → wait → recover. Needs `.env.demo`. |
| `npm run demo:reset-maria` | Resets the recipient account between takes. |

## Repository layout

| Path | What it does |
|---|---|
| [`packages/core`](packages/core) | Pure TypeScript, no UI: intent schema, validation, transaction builder, XDR explainer, predicate evaluation. All the tests live here. |
| [`apps/server`](apps/server) | One endpoint, `POST /api/extract`: chat messages in, structured intent (or a clarifying question) out. |
| [`apps/web`](apps/web) | Vite + React. **Send** (chat or form), **Claim** (recipient), **Sent** (sender recovers). Login and signing through Pollar. |
| [`scripts/`](scripts) | Testnet setup, the wallet-free smoke test, and the demo reset. |

## Limits of v1

- Testnet only. The allowed assets are XLM and a self-issued TESTUSD.
- Recipients are a full `G…` address or a nickname from a fixed demo list (`alice`, `maria`, `bob`).
- The recipient needs an existing Stellar account with enough XLM for a trustline. A Pollar wallet can get the
  trustline sponsored from the Claim page.
- Passkey smart wallets (`C…` addresses) are not supported: claimable balances are classic operations.

## Next

Path payments with a strict worst-case price shown before signing, so "send 50 USDC, pay in XLM" stays just as
explainable.
