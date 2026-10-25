// Sponsored claims: the app's sponsor account pays the fee (and the trustline
// reserve when needed) so a recipient with no spare XLM can still claim.
// The server never signs a transaction it did not build itself: it rebuilds
// the claim from the balance ID and checks it against the ledger first.
import {
  type AccountSnapshot,
  type HorizonClaimableBalance,
  buildSponsoredClaimTx,
  defaultConfig as config,
  hasTrustline,
  viewBalance,
} from "@nilo/core";
import { Horizon, Keypair, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { z } from "zod";

export const SponsorRequest = z.object({
  balanceId: z.string().regex(/^[0-9a-f]{72}$/i),
  claimant: z.string().refine((s) => StrKey.isValidEd25519PublicKey(s), "not a G... address"),
});

export class SponsorError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 503 = 400,
  ) {
    super(message);
  }
}

const horizon = new Horizon.Server(config.horizonUrl);

function sponsorKeypair(): Keypair {
  const secret = process.env.SPONSOR_SECRET;
  if (!secret) throw new SponsorError("The server has no SPONSOR_SECRET, so it cannot sponsor claims.", 503);
  const kp = Keypair.fromSecret(secret);
  if (kp.publicKey() !== config.sponsor) {
    throw new SponsorError("SPONSOR_SECRET does not match the sponsor in the app config. Run npm run setup:testnet.", 503);
  }
  return kp;
}

async function notFoundAsNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if ((e as { response?: { status?: number } }).response?.status === 404) return null;
    throw e;
  }
}

/** Builds the sponsored claim and signs it as the sponsor. The claimant still has to sign. */
export async function sponsorClaim(req: z.infer<typeof SponsorRequest>): Promise<{ xdr: string; trustline: boolean }> {
  const kp = sponsorKeypair();
  const balance = await notFoundAsNull(horizon.claimableBalances().claimableBalance(req.balanceId.toLowerCase()).call());
  if (!balance) throw new SponsorError("This balance no longer exists. It was already claimed or recovered.", 404);

  const view = viewBalance(balance as unknown as HorizonClaimableBalance, req.claimant, Math.floor(Date.now() / 1000));
  if (!view) throw new SponsorError("This account is not a claimant of this balance.", 409);
  // Only recipients are sponsored; a sender recovering their own payment pays as usual.
  if (view.role !== "recipient") throw new SponsorError("Only the recipient's claim is sponsored.", 409);
  if (!view.claimableNow) throw new SponsorError("The deadline has passed: this balance can no longer be claimed.", 409);
  const asset = config.assets.find((a) => a.code === view.asset.code && a.issuer === view.asset.issuer);
  if (!asset) throw new SponsorError(`Nilo does not sponsor claims of ${view.asset.code}.`, 409);

  const claimant = await notFoundAsNull(horizon.loadAccount(req.claimant));
  if (!claimant) throw new SponsorError("Your account does not exist on testnet yet.", 409);
  const needsTrust = !hasTrustline(claimant as unknown as AccountSnapshot, asset);

  const sponsor = await horizon.loadAccount(kp.publicKey());
  const xdr = buildSponsoredClaimTx(view.id, sponsor, req.claimant, config, needsTrust ? asset : undefined);
  const tx = TransactionBuilder.fromXDR(xdr, config.networkPassphrase);
  tx.sign(kp);
  return { xdr: tx.toXDR(), trustline: needsTrust };
}
