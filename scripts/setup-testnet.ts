// One-shot demo setup: issuer + TESTUSD, funded demo accounts, contacts.
// Writes packages/core/src/demo.json (public data) and .env.demo (secrets to import into Freighter).
import { writeFileSync } from "node:fs";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const server = new Horizon.Server(HORIZON_URL);

async function friendbot(pub: string) {
  const res = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
  if (!res.ok) throw new Error(`friendbot failed for ${pub}: ${res.status} ${await res.text()}`);
}

async function submit(source: Keypair, ops: ReturnType<typeof Operation.payment>[], signers: Keypair[] = [source]) {
  const account = await server.loadAccount(source.publicKey());
  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }).setTimeout(60);
  ops.forEach((op) => builder.addOperation(op));
  const tx = builder.build();
  signers.forEach((kp) => tx.sign(kp));
  await server.submitTransaction(tx);
}

const issuer = Keypair.random();
const alice = Keypair.random();
const maria = Keypair.random();
const bob = Keypair.random();
const testusd = new Asset("TESTUSD", issuer.publicKey());

console.log("Funding accounts via Friendbot...");
await Promise.all([issuer, alice, maria, bob].map((kp) => friendbot(kp.publicKey())));

console.log("Alice: trustline to TESTUSD");
await submit(alice, [Operation.changeTrust({ asset: testusd })]);

console.log("Issuer: pay 10000 TESTUSD to Alice");
await submit(issuer, [Operation.payment({ destination: alice.publicKey(), asset: testusd, amount: "10000" })]);

// Maria and Bob intentionally have no TESTUSD trustline: the claim page adds it (changeTrust + claim).
const demo = {
  network: "TESTNET",
  networkPassphrase: Networks.TESTNET,
  horizonUrl: HORIZON_URL,
  assets: [{ code: "XLM" }, { code: "TESTUSD", issuer: issuer.publicKey() }],
  contacts: { alice: alice.publicKey(), maria: maria.publicKey(), bob: bob.publicKey() },
};
writeFileSync("packages/core/src/demo.json", JSON.stringify(demo, null, 2) + "\n");
writeFileSync(
  ".env.demo",
  [
    `ISSUER_SECRET=${issuer.secret()}`,
    `ALICE_SECRET=${alice.secret()}`,
    `MARIA_SECRET=${maria.secret()}`,
    `BOB_SECRET=${bob.secret()}`,
    "",
  ].join("\n"),
);
console.log("Done.", demo.contacts, "issuer:", issuer.publicKey());
console.log("Secrets written to .env.demo — import ALICE and MARIA into Freighter (testnet).");
