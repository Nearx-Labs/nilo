import { Account, Keypair, Networks } from "@stellar/stellar-sdk";
import type { AccountSnapshot, AppConfig } from "../src";

const kp = (n: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n)).publicKey();

export const ISSUER = kp(1);
export const ALICE = kp(2);
export const MARIA = kp(3);
export const STRANGER = kp(4);

export const config: AppConfig = {
  networkPassphrase: Networks.TESTNET,
  horizonUrl: "https://horizon-testnet.stellar.org",
  assets: [{ code: "XLM" }, { code: "TESTUSD", issuer: ISSUER }],
  contacts: { alice: ALICE, maria: MARIA },
};

export const NOW = new Date("2026-10-25T12:00:00Z");
export const NOW_SEC = NOW.getTime() / 1000;

export const aliceAccount = () => new Account(ALICE, "100");

export function snapshot(xlm: string, testusd?: string, subentries = testusd ? 1 : 0): AccountSnapshot {
  return {
    account_id: ALICE,
    subentry_count: subentries,
    balances: [
      ...(testusd
        ? [{ asset_type: "credit_alphanum12", asset_code: "TESTUSD", asset_issuer: ISSUER, balance: testusd }]
        : []),
      { asset_type: "native", balance: xlm },
    ],
  };
}
