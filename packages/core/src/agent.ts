// The NiloAgent mandate: what a user lets Nilo's agent do with their USDC while
// they are away, and the contract calls that set it up or act on it. Pure: no network.
import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export const VENUE_XOXNO = 1;
/** USDC delivered by Circle CCTP to the user's own wallet on Base. */
export const VENUE_CROSSCHAIN = 2;
export type VenueId = typeof VENUE_XOXNO | typeof VENUE_CROSSCHAIN;

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
  /** Venues this deployment can reach. */
  venues: VenueId[];
  /** Circle's attestation API for the CCTP leg. */
  irisUrl: string;
  /** CCTP domain and RPC of the destination chain, and Circle USDC there. */
  destination: { domain: number; name: string; rpcUrl: string; usdc: string; explorer: string };
  /** Most Circle's forwarder may keep per cross-chain move, in USDC (the contract enforces it). */
  maxBridgeFee: number;
}

export const TESTNET_AGENT: AgentConfig = {
  contract: "CDDWGI7BZMRP4H4NREJVGO56RWIZISX6BARK5T3MZGHLK5JAXW2R7YZJ",
  operator: "GA3LXZFTBW6PQQUKAK26MPY3A3TV4MNMWDC3MUCLTHXAFQJ6NDJSMCGZ",
  usdcContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  xoxnoController: "CCXRWJ6SIU2WPFEGLFGJVITPL57QAYIMIO6OAM2NBGNDQSSCK2FFV3F3",
  rpcUrl: "https://soroban-testnet.stellar.org",
  venues: [VENUE_XOXNO, VENUE_CROSSCHAIN],
  irisUrl: "https://iris-api-sandbox.circle.com",
  destination: {
    domain: 6,
    name: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorer: "https://sepolia.basescan.org",
  },
  maxBridgeFee: 0.5,
};

export const VENUES: Record<VenueId, { name: string; place: string }> = {
  [VENUE_XOXNO]: { name: "XOXNO Lending", place: "Stellar" },
  [VENUE_CROSSCHAIN]: { name: "USDC in your own wallet", place: "Base, via Circle CCTP" },
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
    summary: "Everything in XOXNO Lending on Stellar.",
    weights: { [VENUE_XOXNO]: 10_000 },
    weeklyLimit: 50,
    keep: 5,
  },
  {
    id: "balanced",
    name: "Balanced",
    profile: "moderate",
    summary: "Mostly XOXNO on Stellar; some USDC moved to your own wallet on Base.",
    weights: { [VENUE_XOXNO]: 6_000, [VENUE_CROSSCHAIN]: 4_000 },
    weeklyLimit: 100,
    keep: 5,
  },
  {
    id: "explorer",
    name: "Explorer",
    profile: "aggressive",
    summary: "Most USDC moved to your own wallet on Base; the rest in XOXNO on Stellar.",
    weights: { [VENUE_XOXNO]: 3_000, [VENUE_CROSSCHAIN]: 7_000 },
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
  /** The user's own EVM wallet (0x…), where cross-chain moves land. */
  evmRecipient?: string;
}

export const WEEK_SECONDS = 7 * 86_400;
const LEDGER_SECONDS = 5;
const STROOPS = 10_000_000n;

export const usdcToStroops = (usdc: number) => BigInt(Math.round(usdc * 1e7));
export const stroopsToUsdc = (stroops: bigint) => Number(stroops) / 1e7;

/** A mandate from a personality, limited to the venues the deployment can reach. */
export function mandateFrom(
  p: Personality,
  now: number,
  days = 30,
  available: VenueId[] = TESTNET_AGENT.venues,
  evmRecipient?: string,
): Mandate {
  const venues = (Object.keys(p.weights).map(Number) as VenueId[]).filter(
    (v) => available.includes(v) && (v !== VENUE_CROSSCHAIN || !!evmRecipient),
  );
  return {
    limit: usdcToStroops(p.weeklyLimit),
    period: WEEK_SECONDS,
    expiresAt: now + days * 86_400,
    venues: venues.reduce((bits, v) => bits | v, 0),
    profile: p.id,
    evmRecipient: venues.includes(VENUE_CROSSCHAIN) ? evmRecipient!.toLowerCase() : undefined,
  };
}

export const isEvmAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

/** CCTP's 32-byte form of an EVM address: 12 zero bytes, then the 20-byte address. */
export function evmToBytes32(a: string): Uint8Array {
  if (!isEvmAddress(a)) throw new Error(`Not an EVM address: ${a}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 20; i++) out[12 + i] = parseInt(a.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

export function bytes32ToEvm(b: Uint8Array): string {
  return `0x${Array.from(b.slice(12), (x) => x.toString(16).padStart(2, "0")).join("")}`;
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
  const venues = ([VENUE_XOXNO, VENUE_CROSSCHAIN] as VenueId[]).filter((v) => allowedVenues & v);
  if (available <= 0n || venues.length === 0) return [];
  const legs = venues.map((venue) => {
    let amount = (available * BigInt(p.weights[venue] ?? 0)) / 10_000n;
    if (venue === VENUE_CROSSCHAIN) amount -= amount % 10n;
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
    field("evm_recipient", m.evmRecipient ? xdr.ScVal.scvBytes(Buffer.from(evmToBytes32(m.evmRecipient))) : xdr.ScVal.scvVoid()),
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
    evmRecipient: v.evm_recipient ? bytes32ToEvm(new Uint8Array(v.evm_recipient as Uint8Array)) : undefined,
  };
}

export const agentCalls = (cfg: AgentConfig) => {
  const c = new Contract(cfg.contract);
  return {
    setMandate: (user: string, m: Mandate, allowance: bigint, ledger: number) =>
      c.call("set_mandate", addr(user), mandateToScVal(m), i128(allowance), u32(ledger)),
    revoke: (user: string) => c.call("revoke", addr(user)),
    invest: (user: string, venue: VenueId, amount: bigint, maxFee = 0n) =>
      c.call("invest", addr(user), u32(venue), i128(amount), i128(maxFee)),
    withdraw: (caller: string, user: string, amount: bigint) => c.call("withdraw", addr(caller), addr(user), i128(amount)),
    mandate: (user: string) => c.call("mandate", addr(user)),
    usage: (user: string) => c.call("usage", addr(user)),
    position: (user: string) => c.call("position", addr(user)),
    xoxnoBalance: (user: string) => c.call("xoxno_balance", addr(user)),
  };
};

