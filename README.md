# Nilo

**Stellar payments that can't get lost.** Type "send 50 USDC to maria, she has 2 minutes" and Nilo sends it as a
claimable balance. Maria can claim it before the deadline. After the deadline, only you can take it back. If you
typed the wrong address, the money comes home.

Before you sign, Nilo explains the transaction in plain English. That explanation is decoded from the transaction
itself, not written by the AI.

> HackMeridian 2026 · Stellar Unlocked track · **testnet only**

![Nilo home: chat with quick actions to send, check the balance, claim, track sent payments, check a price and send in reais](docs/screenshots/home.webp)

## Contents

- [The problem](#the-problem)
- [How a payment flows](#how-a-payment-flows)
- [The recovery rule](#the-recovery-rule)
- [Why you can trust what you sign](#why-you-can-trust-what-you-sign)
- [Prices from Reflector](#prices-from-reflector)
- [The investing agent](#the-investing-agent)
- [Check it yourself](#check-it-yourself)
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

This is what you read before signing "50 USDC to maria, 2 minutes". Every line comes from the transaction bytes;
the "≈ US$" value above it comes from the oracle and is not part of the transaction:

![The payment form, the oracle value and the explanation card decoded from the XDR, with the Sign and send button](docs/screenshots/review.webp)

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

## The investing agent

Nilo can also put idle USDC to work while you are away, without ever holding your key. You sign one **mandate** with
your Pollar wallet. After that, Nilo's agent invests on its own, and a Soroban contract,
[`NiloAgent`](contracts/soroban/nilo-agent/src/lib.rs), decides what it is allowed to do:

- **Signed once:** the mandate sets a weekly limit, the places the money may go, an expiry date, and a USDC allowance to
  the contract. Revoking it sets the allowance back to 0.
- **The operator can only invest:** Nilo's operator key can call `invest`, and the contract refuses anything outside
  the mandate (over the limit, after the expiry, or to a place the mandate doesn't allow).
- **Withdrawals pay only you:** a withdrawal always goes to your wallet, whoever starts it.
- **Two places today, both on testnet:**
  - [XOXNO Lending](https://xoxno.com/docs/stellar-lending) on Stellar: the contract supplies your USDC and keeps one
    XOXNO account per user. This share earns XOXNO's supply rate (about 1.15% a year on testnet).
  - **Your own wallet on Base Sepolia, through Circle CCTP v2.** The contract burns USDC on Stellar, and Circle's
    Forwarding Service mints it on Base and pays the gas there, keeping a small fee (about 0.06 USDC) that the contract
    caps at 0.5 USDC per move. The destination is the EVM address you named in the mandate. **This share doesn't earn
    anything yet:** it lands as plain USDC in your wallet.
- **Personalities:** pick one of three, or write your own rules in the chat (for example *"invest at most 30 dollars a
  week, I'm conservative"*). The model only reads your request; the mandate is built by code, within fixed bounds (at
  most 1,000 USDC a week, for at most 90 days).

  | Personality | XOXNO on Stellar | Your wallet on Base | Weekly limit | Kept in your wallet |
  |---|---|---|---|---|
  | Guardian | 100% | 0% | 50 USDC | 5 USDC |
  | Balanced | 60% | 40% | 100 USDC | 5 USDC |
  | Explorer | 30% | 70% | 250 USDC | 2 USDC |

Before you sign the mandate, a revoke or a withdrawal, the browser decodes the transaction with
[`explainAgent`](packages/core/src/explainAgent.ts), the same way it decodes payments. The check rejects anything else:
another contract, another account, an authorization beyond the expected USDC approval, or a fee above 5 XLM.

The server ([`apps/server/src/agent`](apps/server/src/agent)) builds those transactions, checks every wallet with a
mandate once an hour (`AGENT_INTERVAL_MINUTES`) and also when you ask, and keeps an activity log. The **Agent** page
shows the personalities, the decoded mandate, what is invested, your balance on Base, and what the agent did while you
were away.

## Check it yourself

These run without any `.env`:

```bash
npm install
npm test               # core: payments and agent explainers, tamper cases, allocation (79 tests)
npm run test:contract  # NiloAgent contract (10 tests); needs Rust
```

On-chain, testnet:

| What | Where |
|---|---|
| `NiloAgent` contract | [`CDDWGI7BZMRP4H4NREJVGO56RWIZISX6BARK5T3MZGHLK5JAXW2R7YZJ`](https://stellar.expert/explorer/testnet/contract/CDDWGI7BZMRP4H4NREJVGO56RWIZISX6BARK5T3MZGHLK5JAXW2R7YZJ) |
| Nilo's operator (the only key that can call `invest`) | [`GA3LXZFTBW6PQQUKAK26MPY3A3TV4MNMWDC3MUCLTHXAFQJ6NDJSMCGZ`](https://stellar.expert/explorer/testnet/account/GA3LXZFTBW6PQQUKAK26MPY3A3TV4MNMWDC3MUCLTHXAFQJ6NDJSMCGZ) |
| The agent supplies 8.4 USDC to XOXNO (Explorer, 30%) | [`4beb1e21…`](https://stellar.expert/explorer/testnet/tx/4beb1e214b549a07fa902e81ad42d142224066b3dc864133f18af15d6ab8fe9a) |
| The agent burns 19.6 USDC on Stellar for Base (Explorer, 70%) | [`095e1e38…`](https://stellar.expert/explorer/testnet/tx/095e1e38971910aeaecc0f8674707700ca57d28bbbabe120fdf92c2a80ee2cec) |
| Circle mints it on Base Sepolia | [`0x31602acf…`](https://sepolia.basescan.org/tx/0x31602acf3a6ff58bf3bce62dd91793983eb1ed39713c871d2417e699cd315f7b) |

Read a live mandate without signing anything:

```bash
stellar contract invoke --id CDDWGI7BZMRP4H4NREJVGO56RWIZISX6BARK5T3MZGHLK5JAXW2R7YZJ --network testnet \
  --source-account GA3LXZFTBW6PQQUKAK26MPY3A3TV4MNMWDC3MUCLTHXAFQJ6NDJSMCGZ --send=no \
  -- mandate --user GCXQPCJYM5LUEXO73XMJQ26U2FNVF7PRAVBJGHSBSTIUO3YCRRKYP7O4
```

The smoke scripts redo all of this on testnet with fresh accounts. They need Nilo's operator key
(`NILO_OPERATOR_SECRET`), so they are for the team, not for checking the claims above:

| Command | What it does |
|---|---|
| `npm run smoke:agent` | Mandate, an investment by the operator on its own, an over-limit investment refused, a withdrawal by the operator paying the user, withdraw all, revoke. Against the real XOXNO contract. |
| `npx tsx scripts/smoke-agent-api.ts` | The same through the server's API, as the web app does. It decodes each transaction with `explainAgent` before signing locally in place of Pollar. Needs `npm run dev`. |
| `npx tsx scripts/smoke-crosschain.ts 0x…` | Moves 2 USDC from Stellar to that address on Base Sepolia and waits for Circle to mint it. |

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
   | `VOICE_ALLOWED_ADDRESSES` | Optional. Voice mode is for signed-in wallets, which sign a message once (SEP-53) so the server can tell who opens sessions on its key. Set comma-separated G… addresses to allow only those wallets, e.g. the presenter's during a demo. |
   | `VITE_POLLAR_API_KEY` | Pollar dashboard → Build → API Keys → **publishable** key (`pub_testnet_…`). Never use a secret key here: `VITE_*` values are shipped to the browser. |
   | `SPONSOR_SECRET` | Written for you by step 4. Testnet secret of the account that pays claim fees and trustline reserves. Server-side only. |
   | `NILO_OPERATOR_SECRET` | Optional. The investing agent's operator key; without it the agent stays off and everything else works. It must be the operator the deployed `NiloAgent` trusts, so only the team can run it. |

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

![Claim page: a 10 USDC payment from alice the recipient can claim, and how claiming works](docs/screenshots/claim.webp)

The **Sent** page, as the sender sees it. A payment waits for the recipient until its deadline; once the deadline
passes unclaimed, it turns recoverable:

![Sent page: one payment waiting for the recipient and one nobody claimed before its deadline, with the Recover button](docs/screenshots/sent.webp)

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
| [`contracts/soroban/nilo-agent`](contracts/soroban/nilo-agent) | The `NiloAgent` Soroban contract (Rust) and its tests. |
| [`apps/server`](apps/server) | The agent's routes under `/api/agent` (build the mandate, revoke and withdraw transactions, activate, run, status), plus four endpoints. `POST /api/extract`: chat messages in, a structured send intent, price question or clarifying question out. `POST /api/sponsor-claim`: balance ID and claimant in, a claim signed by the sponsor out. `POST /api/faucet`: an address in, 100 test USDC from the Sozu Faucet, rate-limited per account (1/day), per IP (3/day), per server (20/hour), one at a time, and paused while Sozu says it is out or cooling down. `POST /api/voice/session`: a WebRTC SDP offer and a SEP-53 proof of wallet ownership in, the SDP answer of a GPT-Live voice session out, rate-limited per wallet (10/hour) and per server (60/hour). Nothing is built or signed there: the browser shows the usual review. |
| [`apps/web`](apps/web) | Vite + React. **Agent** (personalities, mandate, what the agent did), **Chat** (send by chat or form, check balance, ask for a price, set up the agent), **Claim** (recipient), **Sent** (sender recovers). Login and signing through Pollar. Works on phones too. |
| [`scripts/`](scripts) | Testnet and sponsor setup, the wallet-free smoke tests (payments and agent), and the demo reset. |

## Limits of v1

- Testnet only. The allowed assets are XLM and Circle's testnet USDC (`GBBD47…LFLA5`).
- Recipients are a full `G…` address or a nickname from a fixed demo list (`alice`, `maria`, `bob`).
- The recipient needs an existing Stellar account. It doesn't need spare XLM: Nilo sponsors the fee and the
  trustline reserve. Sponsoring account creation (`createAccount` with a 0 starting balance) is not done yet.
- One sponsor account, with no rate limit beyond "one claim per balance". That's fine on testnet, but it would need
  limits before mainnet.
- Passkey smart wallets (`C…` addresses) are not supported: claimable balances are classic operations.
- The agent's share on Base is plain USDC in your wallet: it doesn't earn yield there yet, and bringing it back to
  Stellar is up to you.
- The Base share needs an EVM wallet from Pollar, so the Pollar app must have Polygon wallets enabled. Without one,
  the mandate leaves Base out and that share goes to XOXNO.
- The automated checks sign the mandate with local test keys. In the app, Pollar signs the same transaction, but no
  check signs with a real Pollar login.
- XOXNO Lending on Stellar is in mainnet beta with its audit pending, and its code is under a noncommercial license.
  Nilo uses it on testnet only.

## Next

- Put the Base share to work (for example in an ERC-4626 vault), and bring it back to Stellar through CCTP.
- Path payments with a strict worst-case price shown before signing, so "send 50 USDC, pay in XLM" stays just as
  explainable.
