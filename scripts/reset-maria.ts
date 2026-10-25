// Demo prep: maria returns her USDC to alice and drops the trustline,
// so the next claim on stage shows "changeTrust + claim" in one transaction.
import { readFileSync } from "node:fs";
import { Asset, BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { defaultConfig as config } from "../packages/core/src";

const env = Object.fromEntries(
  readFileSync(".env.demo", "utf8").trim().split("\n").map((l) => l.split("=") as [string, string]),
);
const maria = Keypair.fromSecret(env.MARIA_SECRET);
// We don't issue USDC, so it goes back to alice, who sends it again in the next demo.
const alice = Keypair.fromSecret(env.ALICE_SECRET).publicKey();
const server = new Horizon.Server(config.horizonUrl);
const spec = config.assets.find((a) => a.code === "USDC")!;
const usdc = new Asset(spec.code, spec.issuer!);

const account = await server.loadAccount(maria.publicKey());
const line = account.balances.find((b) => "asset_code" in b && b.asset_code === spec.code && b.asset_issuer === spec.issuer);
if (!line) {
  console.log("maria has no USDC trustline. Nothing to do.");
} else {
  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase }).setTimeout(60);
  if (Number(line.balance) > 0) {
    builder.addOperation(Operation.payment({ destination: alice, asset: usdc, amount: line.balance }));
  }
  builder.addOperation(Operation.changeTrust({ asset: usdc, limit: "0" }));
  const tx = builder.build();
  tx.sign(maria);
  const res = await server.submitTransaction(tx);
  console.log(`Returned ${line.balance} USDC to alice and removed the trustline (${res.hash}).`);
}
const after = await server.loadAccount(maria.publicKey());
console.log("maria:", after.balances.map((b) => `${"asset_code" in b ? b.asset_code : "XLM"} ${b.balance}`).join(", "));
