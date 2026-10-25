import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { VOICE_PROOF_MAX_MS, sep53Digest, verifyVoiceProof, voiceProofExpiry, voiceProofMessage } from "../src";

const NOW = Date.parse("2026-10-25T21:00:00.000Z");
const HOUR = 60 * 60_000;

function prove(kp: Keypair, expiresAt = new Date(NOW + 12 * HOUR), address = kp.publicKey()) {
  const message = voiceProofMessage(address, expiresAt);
  return { address: kp.publicKey(), message, signature: Buffer.from(kp.sign(sep53Digest(message))).toString("base64") };
}

describe("voice proof", () => {
  const kp = Keypair.random();

  it("accepts a fresh proof signed by the address it names", () => {
    expect(verifyVoiceProof(prove(kp), NOW)).toEqual({ ok: true });
    expect(voiceProofExpiry(prove(kp).message)).toBe(NOW + 12 * HOUR);
  });

  it("rejects a signature from another key", () => {
    const forged = { ...prove(Keypair.random()), address: kp.publicKey() };
    forged.message = voiceProofMessage(kp.publicKey(), new Date(NOW + HOUR));
    expect(verifyVoiceProof(forged, NOW)).toMatchObject({ ok: false });
  });

  it("rejects a tampered message", () => {
    const p = prove(kp);
    const later = voiceProofMessage(kp.publicKey(), new Date(NOW + 13 * HOUR));
    expect(verifyVoiceProof({ ...p, message: later }, NOW)).toEqual({ ok: false, reason: "bad signature" });
  });

  it("rejects a message naming another address", () => {
    const other = Keypair.random().publicKey();
    expect(verifyVoiceProof(prove(kp, new Date(NOW + HOUR), other), NOW)).toEqual({
      ok: false,
      reason: "the message names another address",
    });
  });

  it("rejects expired proofs and proofs valid for too long", () => {
    expect(verifyVoiceProof(prove(kp, new Date(NOW - 1)), NOW)).toEqual({ ok: false, reason: "expired" });
    expect(verifyVoiceProof(prove(kp, new Date(NOW + VOICE_PROOF_MAX_MS + 1000)), NOW)).toEqual({
      ok: false,
      reason: "valid for too long",
    });
  });

  it("rejects other messages and malformed signatures", () => {
    const p = prove(kp);
    expect(verifyVoiceProof({ ...p, message: "hello" }, NOW)).toEqual({ ok: false, reason: "not a voice mode message" });
    expect(verifyVoiceProof({ ...p, signature: "not base64!" }, NOW)).toEqual({ ok: false, reason: "bad signature" });
  });
});
