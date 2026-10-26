// Drives the agent through the server's API the way the web app does, signing
// locally in place of Pollar: build the mandate, decode and check it, sign,
// activate (the agent invests right away), then withdraw everything and revoke.
// Needs the dev server running (npm run dev). KEEP=1 leaves the mandate active.
import { Transaction } from "@stellar/stellar-sdk";
import { TESTNET_AGENT, defaultConfig, explainAgent, mandateMismatches } from "../packages/core/src";
import { submit } from "../apps/server/src/agent/soroban";
import { testUser } from "./test-user";

const API = process.env.API ?? "http://localhost:8787/api/agent";
const user = await testUser(".env.agent", "API_USER_SECRET", 15);
const address = user.publicKey();

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${json.message}`);
  return json as T;
}

async function signChecked(xdr: string, label: string) {
  const e = explainAgent(xdr, defaultConfig, TESTNET_AGENT);
  if (e.kind !== "agent") throw new Error(`${label} was not recognized: ${e.lines.join(" ")}`);
  console.log(`   decoded ${label}:\n     ${e.lines.slice(0, 4).join("\n     ")}`);
  const tx = new Transaction(xdr, defaultConfig.networkPassphrase);
  tx.sign(user);
  return submit(tx);
}

console.log("1. mandate built by the server, decoded and checked before signing");
const m = await post<{ xdr: string; mandate: { limit: string; period: number; expiresAt: number; venues: number; profile: string }; allowance: string }>(
  "/mandate-tx",
  { address, personality: "guardian" },
);
const decoded = explainAgent(m.xdr, defaultConfig, TESTNET_AGENT);
const wrong = mandateMismatches(decoded, address, { ...m.mandate, limit: BigInt(m.mandate.limit) }, BigInt(m.allowance));
if (wrong.length) throw new Error(`Mandate mismatch: ${wrong.join(", ")}`);
await signChecked(m.xdr, "mandate");

console.log("2. activate: the agent invests on its own");
const { activity } = await post<{ activity: { kind: string; note: string; hash?: string }[] }>("/activate", { address });
for (const a of activity) console.log(`   ${a.kind}: ${a.note}${a.hash ? ` (tx ${a.hash.slice(0, 12)}…)` : ""}`);

console.log("3. status");
const status = await (await fetch(`${API}/status/${address}`)).json();
console.log(`   wallet ${status.wallet} USDC, XOXNO ${status.xoxno.balance} USDC (APY ${(status.xoxno.apy * 100).toFixed(2)}%), spent this week ${status.spentThisPeriod}`);

if (process.env.KEEP) {
  console.log(`Kept the mandate active for ${address}.`);
  process.exit(0);
}
console.log("4. withdraw everything and revoke, both decoded before signing");
await signChecked((await post<{ xdr: string }>("/withdraw-tx", { address, amount: "0" })).xdr, "withdraw");
await signChecked((await post<{ xdr: string }>("/revoke-tx", { address })).xdr, "revoke");
const after = await (await fetch(`${API}/status/${address}`)).json();
console.log(`   wallet ${after.wallet} USDC, XOXNO ${after.xoxno.balance} USDC, mandate ${JSON.stringify(after.mandate)}`);
