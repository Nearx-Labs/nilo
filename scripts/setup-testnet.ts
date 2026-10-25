// One-shot demo setup: funded demo accounts, contacts, Circle testnet USDC for alice.
// Writes packages/core/src/demo.json (public data) and .env.demo (secrets to import into Freighter).
import { writeFileSync } from "node:fs";
import { Keypair, Networks } from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";

async function friendbot(pub: string) {
  const res = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
  if (!res.ok) throw new Error(`friendbot failed for ${pub}: ${res.status} ${await res.text()}`);
}

const alice = Keypair.random();
const maria = Keypair.random();
const bob = Keypair.random();
// Circle's testnet USDC. We don't issue it: alice gets hers from the Sozu Faucet (setup-usdc.ts).
const USDC = { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };

console.log("Funding accounts via Friendbot...");
await Promise.all([alice, maria, bob].map((kp) => friendbot(kp.publicKey())));

// Maria and Bob intentionally have no USDC trustline: the claim page adds it (changeTrust + claim).
const demo = {
  network: "TESTNET",
  networkPassphrase: Networks.TESTNET,
  horizonUrl: HORIZON_URL,
  assets: [{ code: "XLM" }, USDC],
  contacts: { alice: alice.publicKey(), maria: maria.publicKey(), bob: bob.publicKey() },
};
writeFileSync("packages/core/src/demo.json", JSON.stringify(demo, null, 2) + "\n");
writeFileSync(
  ".env.demo",
  [
    `ALICE_SECRET=${alice.secret()}`,
    `MARIA_SECRET=${maria.secret()}`,
    `BOB_SECRET=${bob.secret()}`,
    "",
  ].join("\n"),
);
console.log("Done.", demo.contacts);
console.log("Secrets written to .env.demo — import ALICE and MARIA into Freighter (testnet).");

// The sponsor account (claim fees + trustline reserves) is created by its own script.
await import("./setup-sponsor.ts");
// Alice's USDC trustline and her first USDC from the faucet.
await import("./setup-usdc.ts");
