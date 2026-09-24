import { StrategyType } from "@meteora-ag/dlmm";
import { Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { Effect } from "effect";
import { solSingleSided } from "./amounts.js";
import type { BotConfig } from "./config.js";
import { ConfigError, DlmmError, JupiterError, TxError, reasonOf } from "./errors.js";
import type { JupiterSwapClient } from "./jupiter.js";
import type { DlmmPoolClient } from "./pool.js";
import type { SolanaClient } from "./solana.js";
import { RebalanceStrategy } from "./strategy.js";
import type { PositionSummary, RebalanceDecision, StrategyKind, WithdrawnFunds } from "./types.js";
import { toPositionState } from "./types.js";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

function toSdkStrategy(kind: StrategyKind): StrategyType {
  switch (kind) {
    case "Spot":
      return StrategyType.Spot;
    case "BidAsk":
      return StrategyType.BidAsk;
    case "Curve":
      return StrategyType.Curve;
  }
}

export class PositionManager {
  constructor(
    readonly pool: DlmmPoolClient,
    readonly solana: SolanaClient,
    readonly binsEachSide: number,
    readonly jupiter: JupiterSwapClient | null,
  ) {}

  get owner(): PublicKey {
    return this.solana.owner;
  }

  decide(positions: readonly PositionSummary[], activeBinId: number): RebalanceDecision {
    const range = RebalanceStrategy.buildRange(activeBinId, this.binsEachSide);
    const state = toPositionState(positions, activeBinId);
    switch (state.kind) {
      case "NoPosition":
        return { kind: "Rebalance", reason: "no position for this pool", close: [], openRange: range };
      case "InRange":
        return {
          kind: "Hold",
          reason: `active bin ${activeBinId} inside [${state.position.lowerBinId}, ${state.position.upperBinId}]`,
        };
      case "OutOfRangeBelow":
      case "OutOfRangeAbove":
        return {
          kind: "Rebalance",
          reason: `active bin ${activeBinId} outside [${state.position.lowerBinId}, ${state.position.upperBinId}]`,
          close: [state.position.address],
          openRange: range,
        };
      case "MultiplePositions":
        return {
          kind: "Rebalance",
          reason: `${state.positions.length} positions, consolidating to one`,
          close: state.positions.map((p) => p.address),
          openRange: range,
        };
    }
  }

  closeEmptyPositions(
    addresses: readonly string[],
    dryRun: boolean,
  ): Effect.Effect<string[], DlmmError | TxError> {
    if (dryRun) {
      return Effect.succeed(addresses.map((a) => `dry-run:close-empty:${a}`));
    }
    return Effect.gen(this, function* () {
      const signatures: string[] = [];
      for (const a of addresses) {
        signatures.push(yield* this.pool.closeEmptyPosition(this.solana, a));
      }
      return signatures;
    });
  }

  closePositions(
    positions: readonly PositionSummary[],
    dryRun: boolean,
  ): Effect.Effect<string[], DlmmError | TxError> {
    if (dryRun) {
      return Effect.succeed(positions.map((p) => `dry-run:close:${p.address}`));
    }
    return Effect.gen(this, function* () {
      const signatures: string[] = [];
      for (const p of positions) {
        const txs = yield* Effect.tryPromise({
          try: () =>
            this.pool.inner.removeLiquidity({
              position: new PublicKey(p.address),
              user: this.owner,
              fromBinId: p.lowerBinId,
              toBinId: p.upperBinId,
              bps: new BN(10000),
              shouldClaimAndClose: true,
            }),
          catch: (cause) =>
            new DlmmError({ reason: `removeLiquidity build failed: ${reasonOf(cause)}` }),
        });
        for (const tx of txs) {
          const sig = yield* Effect.tryPromise({
            try: () =>
              sendAndConfirmTransaction(this.solana.connection, tx, [this.solana.wallet]),
            catch: (cause) => new TxError({ reason: `close tx failed: ${reasonOf(cause)}` }),
          });
          signatures.push(sig);
        }
      }
      return signatures;
    });
  }

  private fundedDeposit(
    cfg: BotConfig,
    xIsSol: boolean,
  ): Effect.Effect<{ readonly x: BN; readonly y: BN }, JupiterError | ConfigError> {
    if (cfg.binsEachSide === 0) {
      return Effect.succeed(solSingleSided(cfg.deployLamports, xIsSol));
    }
    return Effect.gen(this, function* () {
      const swap = yield* this.requireSwap(cfg);
      const half = cfg.deployLamports / 2n;
      const solRemainder = cfg.deployLamports - half;
      const counterpart = xIsSol
        ? this.pool.inner.tokenY.mint.address
        : this.pool.inner.tokenX.mint.address;
      const result = yield* swap.swap(
        WSOL_MINT,
        counterpart,
        half,
        this.solana.wallet,
      );
      yield* Effect.log(`swapped: ${result.signature} out=${result.outAmount}`);
      const swapped = new BN(result.outAmount.toString());
      const sol = new BN(solRemainder.toString());
      return xIsSol ? { x: sol, y: swapped } : { x: swapped, y: sol };
    });
  }

  private reuseDeposit(
    cfg: BotConfig,
    funds: WithdrawnFunds,
    xMint: PublicKey,
    yMint: PublicKey,
  ): Effect.Effect<{ readonly x: BN; readonly y: BN }, JupiterError | ConfigError> {
    const xIsSol = xMint.equals(WSOL_MINT);
    if (cfg.binsEachSide === 0) {
      const singleX = funds.x > 0n && funds.y === 0n;
      const singleY = funds.y > 0n && funds.x === 0n;
      if (singleX && !xIsSol) {
        return Effect.gen(this, function* () {
          const swap = yield* this.requireSwap(cfg);
          const result = yield* swap.swap(xMint, yMint, funds.x, this.solana.wallet);
          yield* Effect.log(`swapped: ${result.signature} out=${result.outAmount}`);
          return { x: new BN(0), y: new BN(result.outAmount.toString()) };
        });
      }
      if (singleY && xIsSol) {
        return Effect.gen(this, function* () {
          const swap = yield* this.requireSwap(cfg);
          const result = yield* swap.swap(yMint, xMint, funds.y, this.solana.wallet);
          yield* Effect.log(`swapped: ${result.signature} out=${result.outAmount}`);
          return { x: new BN(result.outAmount.toString()), y: new BN(0) };
        });
      }
      return Effect.succeed({
        x: new BN(funds.x.toString()),
        y: new BN(funds.y.toString()),
      });
    }
    if (funds.x > 0n && funds.y > 0n) {
      return Effect.succeed({
        x: new BN(funds.x.toString()),
        y: new BN(funds.y.toString()),
      });
    }
    return Effect.gen(this, function* () {
      const swap = yield* this.requireSwap(cfg);
      const fromX = funds.x > 0n;
      const total = fromX ? funds.x : funds.y;
      const half = total / 2n;
      const remainder = total - half;
      const result = yield* swap.swap(
        fromX ? xMint : yMint,
        fromX ? yMint : xMint,
        half,
        this.solana.wallet,
      );
      yield* Effect.log(`swapped: ${result.signature} out=${result.outAmount}`);
      const swapped = new BN(result.outAmount.toString());
      const kept = new BN(remainder.toString());
      return fromX ? { x: kept, y: swapped } : { x: swapped, y: kept };
    });
  }

  private requireSwap(
    cfg: BotConfig,
  ): Effect.Effect<JupiterSwapClient, JupiterError | ConfigError> {
    if (!cfg.swapEnabled) {
      return Effect.fail(
        new ConfigError({ reason: "wide range needs SWAP_ENABLED=true or BINS_EACH_SIDE=0" }),
      );
    }
    if (!this.jupiter) {
      return Effect.fail(new ConfigError({ reason: "missing JUPITER_API_KEY for swap leg" }));
    }
    return Effect.succeed(this.jupiter);
  }

  openCentered(
    activeBinId: number,
    cfg: BotConfig,
    funds?: WithdrawnFunds,
  ): Effect.Effect<string, DlmmError | TxError | JupiterError | ConfigError> {
    const range = RebalanceStrategy.buildRange(activeBinId, cfg.binsEachSide);
    const reused = funds !== undefined && funds.x + funds.y > 0n;
    const singleNonSol =
      reused &&
      funds !== undefined &&
      ((funds.x > 0n && funds.y === 0n && !this.pool.inner.tokenX.mint.address.equals(WSOL_MINT)) ||
        (funds.y > 0n && funds.x === 0n && !this.pool.inner.tokenY.mint.address.equals(WSOL_MINT)));
    if (cfg.dryRun) {
      const source = reused && funds !== undefined
        ? `reuse:x=${funds.x}:y=${funds.y}`
        : "funded:DEPLOY_SOL";
      const bothSides = reused && funds !== undefined && funds.x > 0n && funds.y > 0n;
      const swapNote =
        cfg.binsEachSide === 0 ? (singleNonSol ? "swap-all-to-sol" : "as-is")
        : bothSides ? "as-is"
        : "swap-half";
      return Effect.succeed(`dry-run:open:[${range.minBinId},${range.maxBinId}]:${source}:${swapNote}`);
    }
    return Effect.gen(this, function* () {
      const xMint = this.pool.inner.tokenX.mint.address;
      const yMint = this.pool.inner.tokenY.mint.address;
      const xIsSol = xMint.equals(WSOL_MINT);
      const yIsSol = yMint.equals(WSOL_MINT);
      if (xIsSol === yIsSol) {
        return yield* Effect.fail(
          new DlmmError({ reason: "DEPLOY_SOL needs a SOL-paired pool" }),
        );
      }

      let x: BN;
      let y: BN;
      if (funds === undefined || funds.x + funds.y === 0n) {
        ({ x, y } = yield* this.fundedDeposit(cfg, xIsSol));
      } else {
        ({ x, y } = yield* this.reuseDeposit(cfg, funds, xMint, yMint));
      }

      const positionKp = Keypair.generate();
      const tx = yield* Effect.tryPromise({
        try: () =>
          this.pool.inner.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: positionKp.publicKey,
            user: this.owner,
            totalXAmount: x,
            totalYAmount: y,
            strategy: {
              minBinId: range.minBinId,
              maxBinId: range.maxBinId,
              strategyType: toSdkStrategy(cfg.strategyType),
            },
            // SDK takes slippage percent; bps stored in config convert here.
            slippage: cfg.slippageBps / 100,
          }),
        catch: (cause) =>
          new DlmmError({ reason: `initializePosition build failed: ${reasonOf(cause)}` }),
      });
      const sig = yield* Effect.tryPromise({
        try: () =>
          sendAndConfirmTransaction(this.solana.connection, tx, [
            this.solana.wallet,
            positionKp,
          ]),
        catch: (cause) => new TxError({ reason: `open tx failed: ${reasonOf(cause)}` }),
      });
      const opened = yield* Effect.tryPromise({
        try: () => this.pool.inner.getPosition(positionKp.publicKey),
        catch: (cause) => new DlmmError({ reason: `open verify failed: ${reasonOf(cause)}` }),
      });
      const landedX = BigInt(opened.positionData.totalXAmount);
      const landedY = BigInt(opened.positionData.totalYAmount);
      if (landedX === 0n && landedY === 0n) {
        return yield* Effect.fail(
          new DlmmError({
            reason: `open deposited zero: wanted x=${x.toString()} y=${y.toString()} into [${range.minBinId},${range.maxBinId}] sig ${sig}`,
          }),
        );
      }
      yield* Effect.log(
        `opened position ${positionKp.publicKey.toBase58()} balances x=${landedX} y=${landedY}`,
      );
      return sig;
    });
  }
}
