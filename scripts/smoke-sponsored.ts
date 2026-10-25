// End-to-end check of sponsored claims against testnet: maria (no trustline)
// claims with the sponsor paying fee + reserve; her XLM must not change.
// Run: npx tsx --env-file=.env scripts/smoke-sponsored.ts  (needs SPONSOR_SECRET, see setup:sponsor)
import { readFileSync } from "node:fs";
import { Horizon, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { buildSendTx, defaultConfig as config, explain, validateIntent } from "../packages/core/src";
import { sponsorClaim } from "../apps/server/src/sponsor";

const env = Object.fromEntries(
  readFileSync(".env.demo", "utf8").trim().split("\n").map((l) => l.split("=") as [string, string]),
);
const alice = Keypair.fromSecret(env.ALICE_SECRET);
const maria = Keypair.fromSecret(env.MARIA_SECRET);
const server = new Horizon.Server(config.horizonUrl);
const xlm = (a: Horizon.AccountResponse) => a.balances.find((b) => b.asset_type === "native")!.balance;

await import("./reset-maria.ts");

console.log("1) Alice → maria, 5 TESTUSD, 120s");
const aliceAcc = await server.loadAccount(alice.publicKey());
const v = validateIntent({ amount: "5", asset: "TESTUSD", recipient: "maria", deadlineSeconds: 120 }, aliceAcc as any, config);
if (!v.ok) throw new Error(v.reason);
const sent = buildSendTx(v.intent, aliceAcc, config);
const sendTx = TransactionBuilder.fromXDR(sent.xdr, config.networkPassphrase);
sendTx.sign(alice);
await server.submitTransaction(sendTx);

console.log("2) Server refuses a stranger and the sender");
for (const who of [Keypair.random().publicKey(), alice.publicKey()]) {
  await sponsorClaim({ balanceId: sent.balanceId, claimant: who }).then(
    () => { throw new Error(`sponsored a claim for ${who}`); },
    (e) => console.log("  refused as expected:", e.message),
  );
}

console.log("3) Sponsored claim by maria");
const before = await server.loadAccount(maria.publicKey());
const { xdr, trustline } = await sponsorClaim({ balanceId: sent.balanceId, claimant: maria.publicKey() });
const e = explain(xdr, config);
console.log("  trustline:", trustline, "\n  explanation:\n    " + e.lines.join("\n    "));
if (e.kind !== "claim" || !e.fields.sponsored || e.fields.claimant !== maria.publicKey()) throw new Error("bad explanation");
const tx = TransactionBuilder.fromXDR(xdr, config.networkPassphrase);
tx.sign(maria);
console.log("  submitted", (await server.submitTransaction(tx)).hash);

const after = await server.loadAccount(maria.publicKey());
const line = after.balances.find((b) => "asset_code" in b && b.asset_code === "TESTUSD");
console.log("  maria XLM before/after:", xlm(before), "/", xlm(after));
console.log("  maria TESTUSD:", line?.balance, " num_sponsored:", (after as any).num_sponsored);
if (xlm(before) !== xlm(after)) throw new Error("maria's XLM changed");
console.log("OK");
