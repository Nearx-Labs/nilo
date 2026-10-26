// Client for /api/agent. The server builds the transactions; the page decodes
// each one with explainAgent before the user signs it.
import { type Mandate, type PersonalityId } from "@nilo/core";

export interface AgentActivity {
  id: string;
  at: string;
  kind: "mandate" | "invest" | "withdraw" | "revoke" | "skip" | "error";
  trigger?: "schedule" | "activate" | "manual";
  venue?: number;
  amount?: string;
  hash?: string;
  note: string;
}

export interface AgentStatus {
  mandate: { limit: number; period: number; expiresAt: number; venues: number; profile: string; personality: string } | null;
  spentThisPeriod: number;
  periodStart: number;
  wallet: number;
  xoxno: { balance: number; principal: number; account: number; apy: number | null };
  bridged: number;
  activity: AgentActivity[];
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/agent${path}`, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message ?? `The agent is unavailable (${res.status}).`);
  return json as T;
}

export const agentStatus = (address: string) => call<AgentStatus>(`/status/${address}`);

/** What the user asked for in the chat; anything left out comes from the personality. */
export interface AgentRequest {
  personality?: PersonalityId;
  weeklyLimit?: number;
  days?: number;
}

export async function mandateTx(address: string, personality: PersonalityId, rules: AgentRequest = {}) {
  const r = await call<{ xdr: string; mandate: Omit<Mandate, "limit"> & { limit: string }; allowance: string }>("/mandate-tx", {
    address,
    personality,
    weeklyLimit: rules.weeklyLimit,
    days: rules.days,
  });
  return { xdr: r.xdr, mandate: { ...r.mandate, limit: BigInt(r.mandate.limit) } as Mandate, allowance: BigInt(r.allowance) };
}

export const revokeTx = (address: string) => call<{ xdr: string }>("/revoke-tx", { address });
export const withdrawTx = (address: string, amount = "0") => call<{ xdr: string }>("/withdraw-tx", { address, amount });
export const activateAgent = (address: string) => call<{ activity: AgentActivity[] }>("/activate", { address });
export const runAgent = (address: string) => call<{ activity: AgentActivity[] }>("/run", { address });
