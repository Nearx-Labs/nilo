// What the agent remembers between runs: which users have activated a mandate,
// and a log of what it did for them. A JSON file in DATA_DIR; the mandates
// themselves live on-chain, so losing this file loses only the history.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Activity {
  id: string;
  /** ISO time. */
  at: string;
  user: string;
  kind: "mandate" | "invest" | "withdraw" | "revoke" | "skip" | "error";
  /** Why the agent ran: on its schedule, right after activation, or on request. */
  trigger?: "schedule" | "activate" | "manual";
  venue?: number;
  /** USDC, as a decimal string. */
  amount?: string;
  hash?: string;
  note: string;
}

interface State {
  users: string[];
  activity: Activity[];
}

const MAX_ACTIVITY = 1_000;
const dir = process.env.DATA_DIR?.trim() || "data";
const file = join(dir, "agent.json");

function load(): State {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as State;
  } catch {
    return { users: [], activity: [] };
  }
}

const state = load();

function save() {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(state));
  renameSync(`${file}.tmp`, file);
}

export const users = () => [...state.users];

export function addUser(user: string) {
  if (!state.users.includes(user)) {
    state.users.push(user);
    save();
  }
}

export function log(entry: Omit<Activity, "id" | "at">): Activity {
  const a: Activity = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), ...entry };
  state.activity.push(a);
  if (state.activity.length > MAX_ACTIVITY) state.activity.splice(0, state.activity.length - MAX_ACTIVITY);
  save();
  return a;
}

export const activityFor = (user: string, limit = 50) => state.activity.filter((a) => a.user === user).slice(-limit).reverse();
