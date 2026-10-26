// End-to-end check of the NiloAgent contract on testnet, against the real XOXNO
// Lending: the user signs a mandate once, Nilo's operator invests on its own,
// and withdrawals land in the user's wallet. Needs NILO_OPERATOR_SECRET in .env.
import { readFileSync } from "node:fs";
import { Horizon, Keypair } from "@stellar/stellar-sdk";
import {
  TESTNET_AGENT as cfg,
  VENUE_XOXNO,
  agentCalls,
  allowanceFor,
  defaultConfig,
  mandateFrom,
  personality,
  stroopsToUsdc,
  usdcToStroops,
} from "../packages/core/src";
import { currentLedger, invoke, read } from "../apps/server/src/agent/soroban";
import { testUser, usdcBalance } from "./test-user";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const operator = Keypair.fromSecret(env.NILO_OPERATOR_SECRET);
const user = await testUser(".env.agent", "SMOKE_USER_SECRET", 10);
const calls = agentCalls(cfg);
const horizon = new Horizon.Server(defaultConfig.horizonUrl);
const balance = async () => usdcBalance(await horizon.loadAccount(user.publicKey()));

const now = Math.floor(Date.now() / 1000);
const mandate = mandateFrom(personality("guardian")!, now);
const allowance = allowanceFor(mandate, now, await currentLedger());
console.log("1. user signs the mandate (once)");
await invoke(user, calls.setMandate(user.publicKey(), mandate, allowance.amount, allowance.ledger));
console.log("   on-chain mandate:", await read(calls.mandate(user.publicKey())));

const before = await balance();
console.log(`2. operator invests 2 USDC into XOXNO on its own (wallet has ${before} USDC)`);
const invested = await invoke(operator, calls.invest(user.publicKey(), VENUE_XOXNO, usdcToStroops(2)));
console.log(`   tx ${invested.hash}`);
console.log("   position:", await read(calls.position(user.publicKey())));
console.log(`   XOXNO balance: ${stroopsToUsdc(await read<bigint>(calls.xoxnoBalance(user.publicKey())))} USDC, wallet ${await balance()} USDC`);

console.log("3. operator tries more than the weekly limit (must fail)");
try {
  await invoke(operator, calls.invest(user.publicKey(), VENUE_XOXNO, usdcToStroops(49)));
  throw new Error("The contract accepted an investment above the limit.");
} catch (e) {
  console.log(`   refused as expected: ${(e as Error).message.slice(0, 120)}`);
}

console.log("4. operator withdraws 1 USDC: it can only pay the user");
await invoke(operator, calls.withdraw(operator.publicKey(), user.publicKey(), usdcToStroops(1)));
console.log(`   wallet ${await balance()} USDC`);

console.log("5. user withdraws everything and revokes");
await invoke(user, calls.withdraw(user.publicKey(), user.publicKey(), 0n));
await invoke(user, calls.revoke(user.publicKey()));
console.log(`   wallet ${await balance()} USDC (started at ${before}), mandate now:`, await read(calls.mandate(user.publicKey())));
