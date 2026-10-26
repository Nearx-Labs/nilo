// The cross-chain leg: what Circle's forwarder charges, whether a Stellar burn has
// been minted on the destination, and the user's USDC balance there. Read-only.
import { TESTNET_AGENT as cfg, usdcToStroops } from "@nilo/core";

const STELLAR_DOMAIN = 27;

/** The fee to let Circle's forwarder keep, in stroops: its high quote plus 20%, a multiple of 10, under the contract's cap. */
export async function bridgeFee(): Promise<bigint> {
  const res = await fetch(`${cfg.irisUrl}/v2/burn/USDC/fees/${STELLAR_DOMAIN}/${cfg.destination.domain}?forward=true`);
  const quotes = (await res.json()) as { finalityThreshold: number; forwardFee?: { high: number } }[];
  const high = quotes.find((q) => q.finalityThreshold === 2000)?.forwardFee?.high;
  if (!high) throw new Error("Circle did not quote a forwarding fee.");
  // Iris quotes 6 decimals; Stellar amounts have 7.
  let fee = (BigInt(Math.ceil(high * 1.2)) * 10n) / 10n * 10n;
  const cap = usdcToStroops(cfg.maxBridgeFee);
  if (fee > cap) fee = cap;
  return fee;
}

export interface Forward {
  state: "pending" | "forwarded" | "failed";
  forwardTxHash?: string;
}

/** Circle's view of a Stellar burn: attested and forwarded yet? */
export async function forwardStatus(stellarTxHash: string): Promise<Forward> {
  const res = await fetch(`${cfg.irisUrl}/v2/messages/${STELLAR_DOMAIN}?transactionHash=${stellarTxHash}`);
  if (!res.ok) return { state: "pending" };
  const body = (await res.json()) as { messages?: { status?: string; forwardState?: string; forwardTxHash?: string }[] };
  const m = body.messages?.[0];
  if (m?.forwardState === "COMPLETE") return { state: "forwarded", forwardTxHash: m.forwardTxHash };
  if (m?.forwardState === "FAILED") return { state: "failed" };
  return { state: "pending" };
}

export async function waitForForward(stellarTxHash: string, timeoutMs: number): Promise<Forward> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const f = await forwardStatus(stellarTxHash).catch(() => ({ state: "pending" }) as Forward);
    if (f.state !== "pending") return f;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return { state: "pending" };
}

/** Circle USDC held by `address` on the destination chain, in USDC. */
export async function evmUsdc(address: string): Promise<number> {
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const res = await fetch(cfg.destination.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: cfg.destination.usdc, data }, "latest"] }),
  });
  const { result } = (await res.json()) as { result?: string };
  return result ? Number(BigInt(result)) / 1e6 : 0;
}
