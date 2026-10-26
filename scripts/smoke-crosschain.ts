// Real cross-chain check on testnet: a user signs a mandate naming their own EVM
// wallet, Nilo's operator moves 2 USDC through Circle CCTP, and Circle's
// Forwarding Service mints it on Base Sepolia (paying the gas there). No ETH needed.
// Usage: npx tsx scripts/smoke-crosschain.ts 0xYourEvmAddress
import { readFileSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import { Keypair } from "@stellar/stellar-sdk";
import {
  TESTNET_AGENT as cfg,
  VENUE_CROSSCHAIN,
  agentCalls,
  allowanceFor,
  isEvmAddress,
  mandateFrom,
  personality,
  usdcToStroops,
} from "../packages/core/src";
import { bridgeFee, evmUsdc, waitForForward } from "../apps/server/src/agent/cctp";
import { currentLedger, invoke, read } from "../apps/server/src/agent/soroban";
import { testUser } from "./test-user";

setDefaultResultOrder("ipv4first");
const evm = process.argv[2];
if (!evm || !isEvmAddress(evm)) throw new Error("Pass the destination EVM address: npx tsx scripts/smoke-crosschain.ts 0x…");

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const operator = Keypair.fromSecret(env.NILO_OPERATOR_SECRET);
const user = await testUser(".env.agent", "BRIDGE_USER_SECRET", 5);
const calls = agentCalls(cfg);

const now = Math.floor(Date.now() / 1000);
const mandate = mandateFrom(personality("explorer")!, now, 30, cfg.venues, evm);
const allowance = allowanceFor(mandate, now, await currentLedger());
console.log(`1. user signs a mandate whose cross-chain wallet is ${evm}`);
await invoke(user, calls.setMandate(user.publicKey(), mandate, allowance.amount, allowance.ledger));

const before = await evmUsdc(evm);
const fee = await bridgeFee();
console.log(`2. operator bridges 2 USDC (Circle may keep up to ${Number(fee) / 1e7} USDC); ${evm} has ${before} USDC on ${cfg.destination.name}`);
const { hash } = await invoke(operator, calls.invest(user.publicKey(), VENUE_CROSSCHAIN, usdcToStroops(2), fee));
console.log(`   Stellar burn: https://stellar.expert/explorer/testnet/tx/${hash}`);
console.log("   position:", await read(calls.position(user.publicKey())));

console.log("3. waiting for Circle to attest and forward the mint…");
const forward = await waitForForward(hash, 10 * 60_000);
console.log(`   ${forward.state}${forward.forwardTxHash ? `: ${cfg.destination.explorer}/tx/${forward.forwardTxHash}` : ""}`);
console.log(`   ${evm} now has ${await evmUsdc(evm)} USDC on ${cfg.destination.name} (was ${before})`);
