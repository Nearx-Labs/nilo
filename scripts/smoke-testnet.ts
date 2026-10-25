// End-to-end check of the core against testnet, signing with the demo secrets
// (no wallet). Send → claim with trustline; send to a stranger → wait → recover.
import { readFileSync } from "node:fs";
import { Horizon, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  buildClaimTx,
  buildSendTx,
  defaultConfig as config,
  explain,
  hasTrustline,
  mismatches,
  validateIntent,
  viewBalance,
} from "../packages/core/src";

const env = Object.fromEntries(
  readFileSync(".env.demo", "utf8").trim().split("\n").map((l) => l.split("=") as [string, string]),
);
const alice = Keypair.fromSecret(env.ALICE_SECRET);
const maria = Keypair.fromSecret(env.MARIA_SECRET);
const server = new Horizon.Server(config.horizonUrl);
const testusd = config.assets.find((a) => a.code === "TESTUSD")!;

async function signAndSubmit(xdr: string, kp: Keypair) {
  const e = explain(xdr, config);
  console.log("  explanation:\n    " + e.lines.join("\n    "));
  if (e.kind === "unrecognized") throw new Error("explainer refused");
  const tx = TransactionBuilder.fromXDR(xdr, config.networkPassphrase);
  tx.sign(kp);
  const res = await server.submitTransaction(tx);
  console.log("  submitted", res.hash);
}

async function send(recipient: string, deadlineSeconds: number) {
  const account = await server.loadAccount(alice.publicKey());
  const v = validateIntent({ amount: "5", asset: "TESTUSD", recipient, deadlineSeconds }, account as any, config);
  if (!v.ok) throw new Error(v.reason);
  const built = buildSendTx(v.intent, account, config);
  const m = mismatches(explain(built.xdr, config), v.intent, alice.publicKey(), built.deadline);
  if (m.length) throw new Error("mismatch: " + m.join(", "));
  await signAndSubmit(built.xdr, alice);
  return built;
}

async function claim(kp: Keypair, balanceId: string) {
  const account = await server.loadAccount(kp.publicKey());
  const needsTrust = !hasTrustline(account as any, testusd);
  await signAndSubmit(buildClaimTx(balanceId, account, config, needsTrust ? testusd : undefined), kp);
}

console.log("1) Alice → maria, 60s");
const a = await send("maria", 60);
const rec = await server.claimableBalances().claimant(maria.publicKey()).call();
const mine = rec.records.find((r) => r.id === a.balanceId)!;
console.log("  maria sees:", viewBalance(mine as any, maria.publicKey(), Math.floor(Date.now() / 1000)));
console.log("  maria claims (changeTrust if needed + claim)");
await claim(maria, a.balanceId);

console.log("2) Alice → random stranger, 60s; wait; recover");
const stranger = Keypair.random().publicKey();
const before = await server.loadAccount(alice.publicKey());
console.log("  alice XLM before:", before.balances.find((b) => b.asset_type === "native")!.balance);
const b = await send(stranger, 60);
const after = await server.loadAccount(alice.publicKey());
console.log("  alice XLM after send (reserve locked):", after.balances.find((x) => x.asset_type === "native")!.balance,
  "num_sponsoring:", (after as any).num_sponsoring);
try {
  await claim(alice, b.balanceId);
  throw new Error("recovery before deadline should have failed");
} catch (e: any) {
  console.log("  early recovery rejected as expected:", e?.response?.data?.extras?.result_codes ?? e.message);
}
const wait = (b.deadline + 6) * 1000 - Date.now();
console.log(`  waiting ${Math.ceil(wait / 1000)}s for the deadline...`);
await new Promise((r) => setTimeout(r, wait));
await claim(alice, b.balanceId);
const final = await server.loadAccount(alice.publicKey());
console.log("  alice XLM after recover:", final.balances.find((x) => x.asset_type === "native")!.balance);
console.log("OK");
