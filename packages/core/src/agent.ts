// The NiloAgent mandate: what a user lets Nilo's agent do with their USDC while
// they are away, and the contract calls that set it up or act on it. Pure: no network.
import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export const VENUE_XOXNO = 1;
export const VENUE_AAVE_ARBITRUM = 2;
export type VenueId = typeof VENUE_XOXNO | typeof VENUE_AAVE_ARBITRUM;

export interface AgentConfig {
  /** The NiloAgent contract. */
  contract: string;
  /** Nilo's operator key: the only key that can ask the contract to invest. */
  operator: string;
  /** Circle USDC's Stellar asset contract. */
  usdcContract: string;
  /** XOXNO Lending controller. */
  xoxnoController: string;
  rpcUrl: string;
  /** Venues this deployment can reach (the CCTP vault is wired only once deployed). */
  venues: VenueId[];
}

export const TESTNET_AGENT: AgentConfig = {
  contract: "CC4VU642T2Z4IEGANZV4HUIEQDOWP2YONA6AFX53WUHNYGZ5VZTZQTR7",
  operator: "GA3LXZFTBW6PQQUKAK26MPY3A3TV4MNMWDC3MUCLTHXAFQJ6NDJSMCGZ",
  usdcContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  xoxnoController: "CCXRWJ6SIU2WPFEGLFGJVITPL57QAYIMIO6OAM2NBGNDQSSCK2FFV3F3",
  rpcUrl: "https://soroban-testnet.stellar.org",
  venues: [VENUE_XOXNO],
};

export const VENUES: Record<VenueId, { name: string; place: string }> = {
  [VENUE_XOXNO]: { name: "XOXNO Lending", place: "Stellar" },
  [VENUE_AAVE_ARBITRUM]: { name: "Aave", place: "Arbitrum (via Circle CCTP)" },
};

export type PersonalityId = "guardian" | "balanced" | "explorer";

/** Presets for people who don't want to write their own rules. */
export interface Personality {
  id: PersonalityId;
  name: string;
  /** Matches the investor profile from onboarding. */
  profile: "conservative" | "moderate" | "aggressive";
  summary: string;
  /** Share of each investment per venue, in basis points (sums to 10,000). */
  weights: Partial<Record<VenueId, number>>;
  /** Most the agent may invest per week, in USDC. */
  weeklyLimit: number;
  /** USDC the agent always leaves in the wallet. */
  keep: number;
}

export const PERSONALITIES: Personality[] = [
  {
    id: "guardian",
    name: "Guardian",
    profile: "conservative",
    summary: "Stays on Stellar and moves slowly.",
    weights: { [VENUE_XOXNO]: 10_000 },
    weeklyLimit: 50,
    keep: 5,
  },
  {
    id: "balanced",
    name: "Balanced",
    profile: "moderate",
    summary: "Mostly Stellar, some on Arbitrum.",
    weights: { [VENUE_XOXNO]: 6_000, [VENUE_AAVE_ARBITRUM]: 4_000 },
    weeklyLimit: 100,
    keep: 5,
  },
  {
    id: "explorer",
    name: "Explorer",
    profile: "aggressive",
    summary: "Chases yield across chains.",
    weights: { [VENUE_XOXNO]: 3_000, [VENUE_AAVE_ARBITRUM]: 7_000 },
    weeklyLimit: 250,
    keep: 2,
  },
];

export const personalityFor = (profile: Personality["profile"]) => PERSONALITIES.find((p) => p.profile === profile)!;
export const personality = (id: string) => PERSONALITIES.find((p) => p.id === id);

/** What the contract stores for a user. Amounts in stroops (7 decimals). */
export interface Mandate {
  limit: bigint;
  period: number;
  expiresAt: number;
  venues: number;
  profile: string;
}

export const WEEK_SECONDS = 7 * 86_400;
const LEDGER_SECONDS = 5;
const STROOPS = 10_000_000n;

export const usdcToStroops = (usdc: number) => BigInt(Math.round(usdc * 1e7));
export const stroopsToUsdc = (stroops: bigint) => Number(stroops) / 1e7;

/** A mandate from a personality, limited to the venues the deployment can reach. */
export function mandateFrom(p: Personality, now: number, days = 30, available: VenueId[] = TESTNET_AGENT.venues): Mandate {
  const venues = (Object.keys(p.weights).map(Number) as VenueId[]).filter((v) => available.includes(v));
  return {
    limit: usdcToStroops(p.weeklyLimit),
    period: WEEK_SECONDS,
    expiresAt: now + days * 86_400,
    venues: venues.reduce((bits, v) => bits | v, 0),
    profile: p.id,
  };
}

/** Allowance that covers every period until the mandate expires, and the ledger it lasts until. */
export function allowanceFor(m: Mandate, now: number, currentLedger: number): { amount: bigint; ledger: number } {
  const periods = BigInt(Math.max(1, Math.ceil((m.expiresAt - now) / m.period)));
  return { amount: m.limit * periods, ledger: currentLedger + Math.ceil((m.expiresAt - now) / LEDGER_SECONDS) + 1_000 };
}

/**
 * How the agent splits `available` stroops across the mandate's venues by the personality's weights.
 * A venue the mandate doesn't allow gives its share to the first allowed venue. CCTP amounts are
 * rounded down to whole 6-decimal units; the remainder stays with the first venue.
 */
export function split(available: bigint, p: Personality, allowedVenues: number): { venue: VenueId; amount: bigint }[] {
  const venues = ([VENUE_XOXNO, VENUE_AAVE_ARBITRUM] as VenueId[]).filter((v) => allowedVenues & v);
  if (available <= 0n || venues.length === 0) return [];
  const legs = venues.map((venue) => {
    let amount = (available * BigInt(p.weights[venue] ?? 0)) / 10_000n;
    if (venue === VENUE_AAVE_ARBITRUM) amount -= amount % 10n;
    return { venue, amount };
  });
  const rest = available - legs.reduce((s, l) => s + l.amount, 0n);
  legs[0].amount += rest;
  return legs.filter((l) => l.amount > 0n);
}

const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const u64 = (n: number) => nativeToScVal(n, { type: "u64" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const addr = (a: string) => new Address(a).toScVal();
const field = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: nativeToScVal(key, { type: "symbol" }), val });

/** Soroban struct encoding: a map with its fields sorted by name. */
export function mandateToScVal(m: Mandate): xdr.ScVal {
  return xdr.ScVal.scvMap([
    field("expires_at", u64(m.expiresAt)),
    field("limit", i128(m.limit)),
    field("period", u64(m.period)),
    field("profile", nativeToScVal(m.profile, { type: "symbol" })),
    field("venues", u32(m.venues)),
  ]);
}

export function mandateFromNative(v: Record<string, unknown>): Mandate {
  return {
    limit: BigInt(v.limit as bigint),
    period: Number(v.period),
    expiresAt: Number(v.expires_at),
    venues: Number(v.venues),
    profile: String(v.profile),
  };
}

export const agentCalls = (cfg: AgentConfig) => {
  const c = new Contract(cfg.contract);
  return {
    setMandate: (user: string, m: Mandate, allowance: bigint, ledger: number) =>
      c.call("set_mandate", addr(user), mandateToScVal(m), i128(allowance), u32(ledger)),
    revoke: (user: string) => c.call("revoke", addr(user)),
    invest: (user: string, venue: VenueId, amount: bigint) => c.call("invest", addr(user), u32(venue), i128(amount)),
    withdraw: (caller: string, user: string, amount: bigint) => c.call("withdraw", addr(caller), addr(user), i128(amount)),
    mandate: (user: string) => c.call("mandate", addr(user)),
    usage: (user: string) => c.call("usage", addr(user)),
    position: (user: string) => c.call("position", addr(user)),
    xoxnoBalance: (user: string) => c.call("xoxno_balance", addr(user)),
  };
};

