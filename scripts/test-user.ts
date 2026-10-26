// Creates a throwaway testnet user for smoke tests: funds it with Friendbot,
// adds the USDC trustline and buys USDC with Friendbot XLM on the testnet DEX
// (the Sozu Faucet limits claims per IP). Reuses the secret in the given env
// file when it is already there.
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { Asset, BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { type AccountSnapshot, defaultConfig as config, hasTrustline, toSdkAsset } from "../packages/core/src";

const server = new Horizon.Server(config.horizonUrl);
const usdc = config.assets.find((a) => a.code === "USDC" && a.issuer)!;

export const usdcBalance = (a: Horizon.AccountResponse) =>
  Number(a.balances.find((b) => "asset_code" in b && b.asset_code === usdc.code && b.asset_issuer === usdc.issuer)?.balance ?? 0);

function readSecret(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8").match(new RegExp(`^${key}=(S[A-Z0-9]{55})$`, "m"))?.[1];
}

/** Returns a funded keypair with at least `minUsdc` USDC, creating it under `key` in `file` if needed. */
export async function testUser(file: string, key: string, minUsdc = 10): Promise<Keypair> {
  const existing = readSecret(file, key);
  const kp = existing ? Keypair.fromSecret(existing) : Keypair.random();
  if (!existing) {
    const res = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
    if (!res.ok) throw new Error(`Friendbot refused ${kp.publicKey()} (${res.status}).`);
    appendFileSync(file, `${key}=${kp.secret()}\n`);
  }
  let account = await server.loadAccount(kp.publicKey());
  if (!hasTrustline(account as unknown as AccountSnapshot, usdc)) {
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
      .addOperation(Operation.changeTrust({ asset: toSdkAsset(usdc) }))
      .setTimeout(60)
      .build();
    tx.sign(kp);
    await server.submitTransaction(tx);
    account = await server.loadAccount(kp.publicKey());
  }
  if (usdcBalance(account) < minUsdc) {
    const want = (minUsdc * 2).toFixed(7);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
      .addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset: Asset.native(),
          sendMax: String(minUsdc * 10),
          destination: kp.publicKey(),
          destAsset: toSdkAsset(usdc),
          destAmount: want,
        }),
      )
      .setTimeout(60)
      .build();
    tx.sign(kp);
    await server.submitTransaction(tx);
    account = await server.loadAccount(kp.publicKey());
  }
  console.log(`${key}: ${kp.publicKey()} has ${usdcBalance(account)} USDC`);
  return kp;
}
