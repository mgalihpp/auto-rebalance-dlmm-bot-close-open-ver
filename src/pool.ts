import type {
  BinLiquidity,
  LbPosition,
  TInitializePositionAndAddLiquidityParamsByStrategy,
} from "@meteora-ag/dlmm";
import { PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import type { Connection, Transaction } from "@solana/web3.js";
import type BN from "bn.js";
import { Effect } from "effect";
import { createRequire } from "node:module";
import { DlmmError, TxError, reasonOf } from "./errors.js";
import type { SolanaClient } from "./solana.js";
import type { PositionSummary } from "./types.js";

export interface RemoveLiquidityArgs {
  readonly user: PublicKey;
  readonly position: PublicKey;
  readonly fromBinId: number;
  readonly toBinId: number;
  readonly bps: BN;
  readonly shouldClaimAndClose?: boolean;
}

// Narrow structural view of the SDK class. The SDK ships CJS packaging
// without a "type" field, so under moduleResolution NodeNext tsc models its
// default export as the module namespace and a static default import never
// typechecks. Payload types above still come from the SDK itself.
export interface DlmmLike {
  readonly tokenX: { readonly mint: { readonly address: PublicKey } };
  readonly tokenY: { readonly mint: { readonly address: PublicKey } };
  getActiveBin(): Promise<BinLiquidity>;
  getPosition(positionPubKey: PublicKey): Promise<LbPosition>;
  getPositionsByUserAndLbPair(
    userPubKey?: PublicKey,
  ): Promise<{ userPositions: Array<LbPosition> }>;
  refetchStates(): Promise<void>;
  removeLiquidity(args: RemoveLiquidityArgs): Promise<Transaction[]>;
  closePositionIfEmpty(args: { owner: PublicKey; position: LbPosition }): Promise<Transaction>;
  initializePositionAndAddLiquidityByStrategy(
    args: TInitializePositionAndAddLiquidityParamsByStrategy,
  ): Promise<Transaction>;
}

interface DlmmStatic {
  create(connection: Connection, poolAddress: PublicKey): Promise<DlmmLike>;
}

function loadDlmmClass(): DlmmStatic {
  const req = createRequire(import.meta.url);
  const mod = req("@meteora-ag/dlmm") as unknown as DlmmStatic | { default: DlmmStatic };
  if ("create" in mod && typeof mod.create === "function") return mod;
  return (mod as { default: DlmmStatic }).default;
}

export class DlmmPoolClient {
  private constructor(
    readonly inner: DlmmLike,
    readonly poolAddress: PublicKey,
  ) {}

  static load(
    client: SolanaClient,
    poolAddress: string,
  ): Effect.Effect<DlmmPoolClient, DlmmError> {
    return Effect.gen(function* () {
      const address = new PublicKey(poolAddress);
      const inner = yield* Effect.tryPromise({
        try: () => loadDlmmClass().create(client.connection, address),
        catch: (cause) => new DlmmError({ reason: `DLMM.create failed: ${reasonOf(cause)}` }),
      });
      return new DlmmPoolClient(inner, address);
    });
  }

  refetch(): Effect.Effect<void, DlmmError> {
    return Effect.tryPromise({
      try: () => this.inner.refetchStates(),
      catch: (cause) => new DlmmError({ reason: `refetchStates failed: ${reasonOf(cause)}` }),
    });
  }

  getActiveBinId(): Effect.Effect<number, DlmmError> {
    return Effect.tryPromise({
      try: () => this.inner.getActiveBin().then((bin) => bin.binId),
      catch: (cause) => new DlmmError({ reason: `getActiveBin failed: ${reasonOf(cause)}` }),
    });
  }

  getUserPositions(owner: PublicKey): Effect.Effect<PositionSummary[], DlmmError> {
    return Effect.tryPromise({
      try: () =>
        this.inner.getPositionsByUserAndLbPair(owner).then(({ userPositions }) =>
          userPositions.map((p) => ({
            address: p.publicKey.toBase58(),
            lowerBinId: p.positionData.lowerBinId,
            upperBinId: p.positionData.upperBinId,
            amountX:
              BigInt(p.positionData.totalXAmount) + BigInt(p.positionData.feeX.toString()),
            amountY:
              BigInt(p.positionData.totalYAmount) + BigInt(p.positionData.feeY.toString()),
          })),
        ),
      catch: (cause) =>
        new DlmmError({ reason: `getPositionsByUserAndLbPair failed: ${reasonOf(cause)}` }),
    });
  }

  closeEmptyPosition(
    solana: SolanaClient,
    positionAddress: string,
  ): Effect.Effect<string, DlmmError | TxError> {
    return Effect.gen(this, function* () {
      const position = yield* Effect.tryPromise({
        try: () => this.inner.getPosition(new PublicKey(positionAddress)),
        catch: (cause) => new DlmmError({ reason: `getPosition failed: ${reasonOf(cause)}` }),
      });
      const tx = yield* Effect.tryPromise({
        try: () => this.inner.closePositionIfEmpty({ owner: solana.owner, position }),
        catch: (cause) =>
          new DlmmError({ reason: `closePositionIfEmpty build failed: ${reasonOf(cause)}` }),
      });
      return yield* Effect.tryPromise({
        try: () => sendAndConfirmTransaction(solana.connection, tx, [solana.wallet]),
        catch: (cause) => new TxError({ reason: `close-empty tx failed: ${reasonOf(cause)}` }),
      });
    });
  }
}
