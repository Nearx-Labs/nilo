// The investor profile a user picks on first sign-in, kept in localStorage per
// address. It is only stored and shown for now; nothing else depends on it.
import { useCallback, useSyncExternalStore } from "react";

export type InvestorProfile = "conservative" | "moderate" | "aggressive";

export const PROFILES: { id: InvestorProfile; label: string; text: string }[] = [
  { id: "conservative", label: "Conservative", text: "Preserve capital first. Mostly stablecoins, little volatility." },
  { id: "moderate", label: "Moderate", text: "A balance between stability and growth." },
  { id: "aggressive", label: "Aggressive", text: "Accept volatility in exchange for higher potential returns." },
];

const key = (address: string) => `nilo.profile.v1.${address}`;
const isProfile = (v: unknown): v is InvestorProfile => PROFILES.some((p) => p.id === v);

// Storage can be missing or full (private windows); the in-memory copy still works.
const memory = new Map<string, InvestorProfile | null>();
const listeners = new Set<() => void>();

function read(address: string): InvestorProfile | null {
  if (!memory.has(address)) {
    let saved: unknown = null;
    try {
      saved = localStorage.getItem(key(address));
    } catch {
      // Not readable; start without a profile.
    }
    memory.set(address, isProfile(saved) ? saved : null);
  }
  return memory.get(address) ?? null;
}

function write(address: string, profile: InvestorProfile) {
  memory.set(address, profile);
  try {
    localStorage.setItem(key(address), profile);
  } catch {
    // Not persisted; the in-memory copy still holds it.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The saved profile for `address` (null when none) and a setter. */
export function useProfile(address: string | null): [InvestorProfile | null, (p: InvestorProfile) => void] {
  const profile = useSyncExternalStore(subscribe, () => (address ? read(address) : null));
  const set = useCallback((p: InvestorProfile) => address && write(address, p), [address]);
  return [profile, set];
}

export const profileLabel = (p: InvestorProfile) => PROFILES.find((x) => x.id === p)!.label;
