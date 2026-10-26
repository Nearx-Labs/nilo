// Soroban RPC helpers for the agent: read a contract view by simulation, or
// simulate, sign and submit a call and wait for it to land.
import { Keypair, TransactionBuilder, rpc, scValToNative, xdr, type Transaction } from "@stellar/stellar-sdk";
import { TESTNET_AGENT, defaultConfig } from "@nilo/core";

export const server = new rpc.Server(TESTNET_AGENT.rpcUrl);
const passphrase = defaultConfig.networkPassphrase;

// Simulations need a funded source account; any will do for read-only calls.
const READER = TESTNET_AGENT.operator;

export async function read<T = unknown>(op: xdr.Operation): Promise<T> {
  const source = await server.getAccount(READER);
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: passphrase }).addOperation(op).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return scValToNative(sim.result!.retval) as T;
}

// Interest keeps accruing between simulation and execution, so lending calls can need a little
// more CPU than simulated; without headroom a "withdraw all" fails with resource_limit_exceeded.
const CPU_HEADROOM = 2_000_000;

/** Builds an unsigned, simulated transaction for `source` (used when a user signs elsewhere). */
export async function prepare(source: string, op: xdr.Operation): Promise<Transaction> {
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: passphrase }).addOperation(op).setTimeout(120).build();
  const sim = await server.simulateTransaction(tx, { cpuInstructions: CPU_HEADROOM });
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return rpc.assembleTransaction(tx, sim).build();
}

export interface Submitted {
  hash: string;
  result: unknown;
}

export async function invoke(signer: Keypair, op: xdr.Operation): Promise<Submitted> {
  const tx = await prepare(signer.publicKey(), op);
  tx.sign(signer);
  return submit(tx);
}

export async function submit(tx: Transaction): Promise<Submitted> {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`Rejected: ${JSON.stringify(sent.errorResult ?? sent.status)}`);
  const done = await server.pollTransaction(sent.hash, { attempts: 30, sleepStrategy: () => 1_000 });
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`Transaction ${sent.hash} ${done.status}.`);
  return { hash: sent.hash, result: done.returnValue ? scValToNative(done.returnValue) : undefined };
}

export async function currentLedger(): Promise<number> {
  return (await server.getLatestLedger()).sequence;
}
