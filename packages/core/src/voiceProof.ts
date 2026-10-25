import { Keypair, StrKey, hash } from "@stellar/stellar-sdk";
import { z } from "zod";

/**
 * Proof that the browser controls a wallet, for voice mode: a SEP-53 signed message naming the
 * address and an expiry. The server only creates voice sessions (billed to its OpenAI key) for
 * a valid proof, so its limits count wallets, not IPs.
 */
export const VoiceProofSchema = z.object({
  address: z.string().refine((s) => StrKey.isValidEd25519PublicKey(s), "not a G... address"),
  message: z.string().max(200),
  /** base64 ed25519 signature over SHA-256("Stellar Signed Message:\n" + message). */
  signature: z.string().max(200),
});
export type VoiceProof = z.infer<typeof VoiceProofSchema>;

/** The longest a proof may be valid for, whatever the message says. */
export const VOICE_PROOF_MAX_MS = 24 * 60 * 60_000;

const TITLE = "Nilo voice mode";
const MESSAGE_RE = /^Nilo voice mode\nAddress: (G[A-Z2-7]{55})\nExpires: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

/** What the wallet signs. */
export function voiceProofMessage(address: string, expiresAt: Date): string {
  return `${TITLE}\nAddress: ${address}\nExpires: ${expiresAt.toISOString()}`;
}

/** When a proof's message expires (unix ms), or null if it is not a voice proof message. */
export function voiceProofExpiry(message: string): number | null {
  const m = MESSAGE_RE.exec(message);
  return m ? Date.parse(m[2]) : null;
}

/** The SEP-53 digest a wallet signs for `message`. */
export function sep53Digest(message: string): Uint8Array {
  return hash(new TextEncoder().encode(`Stellar Signed Message:\n${message}`));
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export function verifyVoiceProof(proof: VoiceProof, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  const m = MESSAGE_RE.exec(proof.message);
  if (!m) return { ok: false, reason: "not a voice mode message" };
  if (m[1] !== proof.address) return { ok: false, reason: "the message names another address" };
  const expires = Date.parse(m[2]);
  if (!(expires > now)) return { ok: false, reason: "expired" };
  if (expires > now + VOICE_PROOF_MAX_MS) return { ok: false, reason: "valid for too long" };
  let valid = false;
  try {
    valid = Keypair.fromPublicKey(proof.address).verify(sep53Digest(proof.message), fromBase64(proof.signature));
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: "bad signature" };
}
