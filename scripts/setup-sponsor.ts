// Creates the account that sponsors claims (fees + trustline reserves) and
// records it: public key in packages/core/src/demo.json, SPONSOR_SECRET in
// .env.demo and .env (server-side only). Safe to rerun: it replaces the sponsor.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";

const DEMO = "packages/core/src/demo.json";

const sponsor = Keypair.random();
console.log("Sponsor: funding via Friendbot...");
const res = await fetch(`https://friendbot.stellar.org?addr=${sponsor.publicKey()}`);
if (!res.ok) throw new Error(`friendbot failed for ${sponsor.publicKey()}: ${res.status} ${await res.text()}`);

const demo = JSON.parse(readFileSync(DEMO, "utf8"));
demo.sponsor = sponsor.publicKey();
writeFileSync(DEMO, JSON.stringify(demo, null, 2) + "\n");

function setEnv(file: string) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => !l.startsWith("SPONSOR_SECRET=")) : [];
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  writeFileSync(file, [...lines, `SPONSOR_SECRET=${sponsor.secret()}`, ""].join("\n"));
}
setEnv(".env.demo");
setEnv(".env");
console.log(`Sponsor ${sponsor.publicKey()} written to ${DEMO}; SPONSOR_SECRET written to .env and .env.demo.`);
console.log("Restart the server (npm run dev) so it picks up SPONSOR_SECRET.");
