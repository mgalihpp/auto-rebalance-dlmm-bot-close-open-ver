import { VersionedTransaction, type Keypair, type PublicKey } from "@solana/web3.js";
import { Effect } from "effect";
import { JupiterError, reasonOf } from "./errors.js";

const BASE_URL = "https://api.jup.ag/swap/v2";

interface OrderResponse {
  readonly transaction: string | null;
  readonly requestId: string;
  readonly outAmount: string;
  readonly router: string;
  readonly mode: string;
  readonly feeBps: number;
  readonly feeMint: string;
  readonly errorCode?: number;
  readonly errorMessage?: string;
}

interface ExecuteResponse {
  readonly status: "Success" | "Failed";
  readonly signature: string;
  readonly code: number;
  readonly totalInputAmount: string;
  readonly totalOutputAmount: string;
  readonly inputAmountResult: string;
  readonly outputAmountResult: string;
  readonly error?: string;
}

export interface SwapResult {
  readonly signature: string;
  readonly outAmount: bigint;
}

export class JupiterSwapClient {
  constructor(readonly apiKey: string) {}

  swap(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: bigint,
    signer: Keypair,
  ): Effect.Effect<SwapResult, JupiterError> {
    return Effect.gen(this, function* () {
      const params = new URLSearchParams({
        inputMint: inputMint.toBase58(),
        outputMint: outputMint.toBase58(),
        amount: amount.toString(),
        taker: signer.publicKey.toBase58(),
      });
      const orderRes = yield* Effect.tryPromise({
        try: () => fetch(`${BASE_URL}/order?${params}`, { headers: { "x-api-key": this.apiKey } }),
        catch: (cause) => new JupiterError({ reason: `order request failed: ${reasonOf(cause)}` }),
      });
      if (!orderRes.ok) {
        const body = yield* Effect.promise(() => orderRes.text());
        return yield* Effect.fail(
          new JupiterError({ reason: `order failed: ${orderRes.status} ${body}` }),
        );
      }
      const order = (yield* Effect.tryPromise({
        try: () => orderRes.json() as Promise<OrderResponse>,
        catch: (cause) => new JupiterError({ reason: `order parse failed: ${reasonOf(cause)}` }),
      }));
      if (!order.transaction) {
        return yield* Effect.fail(
          new JupiterError({
            reason: `no route: [${order.router}] ${order.errorCode ?? "?"} ${order.errorMessage ?? "empty transaction"}`,
          }),
        );
      }

      const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
      tx.sign([signer]);
      const signed = Buffer.from(tx.serialize()).toString("base64");

      const execRes = yield* Effect.tryPromise({
        try: () =>
          fetch(`${BASE_URL}/execute`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": this.apiKey },
            body: JSON.stringify({ signedTransaction: signed, requestId: order.requestId }),
          }),
        catch: (cause) => new JupiterError({ reason: `execute request failed: ${reasonOf(cause)}` }),
      });
      if (!execRes.ok) {
        const body = yield* Effect.promise(() => execRes.text());
        return yield* Effect.fail(
          new JupiterError({ reason: `execute failed: ${execRes.status} ${body}` }),
        );
      }
      const exec = (yield* Effect.tryPromise({
        try: () => execRes.json() as Promise<ExecuteResponse>,
        catch: (cause) => new JupiterError({ reason: `execute parse failed: ${reasonOf(cause)}` }),
      }));
      if (exec.status !== "Success") {
        return yield* Effect.fail(
          new JupiterError({
            reason: `swap failed: code ${exec.code} ${exec.error ?? ""} sig ${exec.signature}`,
          }),
        );
      }
      return { signature: exec.signature, outAmount: BigInt(exec.totalOutputAmount) };
    });
  }
}
