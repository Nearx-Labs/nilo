// Gives alice Circle's testnet USDC: adds her USDC trustline if missing, then
// claims from the Sozu Faucet (100 USDC per claim). Safe to rerun; the faucet
// has its own cooldown. Needs .env.demo from setup:testnet.
import { readFileSync } from "node:fs";
import { BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { type AccountSnapshot, defaultConfig as config, hasTrustline, toSdkAsset } from "../packages/core/src";
import { claimFromSozu } from "../apps/server/src/faucet";

const env = Object.fromEntries(
  readFileSync(".env.demo", "utf8").trim().split("\n").map((l) => l.split("=") as [string, string]),
);
const alice = Keypair.fromSecret(env.ALICE_SECRET);
const server = new Horizon.Server(config.horizonUrl);
const usdc = config.assets.find((a) => a.code === "USDC" && a.issuer);
if (!usdc) throw new Error("No USDC asset in packages/core/src/demo.json.");
const usdcBalance = (a: Horizon.AccountResponse) =>
  a.balances.find((b) => "asset_code" in b && b.asset_code === usdc.code && b.asset_issuer === usdc.issuer)?.balance ?? "none";

let account = await server.loadAccount(alice.publicKey());
if (!hasTrustline(account as unknown as AccountSnapshot, usdc)) {
  console.log("Alice: trustline to USDC");
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(Operation.changeTrust({ asset: toSdkAsset(usdc) }))
    .setTimeout(60)
    .build();
  tx.sign(alice);
  await server.submitTransaction(tx);
}

console.log("Alice: claiming USDC from the Sozu Faucet (solving its proof of work)...");
try {
  const { amount } = await claimFromSozu(alice.publicKey());
  console.log(`Claimed ${amount || "?"} USDC.`);
} catch (e) {
  console.warn(`The faucet did not pay: ${(e as Error).message}`);
}
account = await server.loadAccount(alice.publicKey());
console.log(`Alice USDC: ${usdcBalance(account)}  https://stellar.expert/explorer/testnet/account/${alice.publicKey()}`);
