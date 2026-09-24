import { Effect } from "effect";
import type { BotConfig } from "./config.js";
import type { ConfigError, DlmmError, JupiterError, RpcError, TxError } from "./errors.js";
import type { DlmmPoolClient } from "./pool.js";
import type { PositionManager } from "./position.js";
import type { SolanaClient } from "./solana.js";
import type { PositionSummary, RebalanceDecision } from "./types.js";
import { sumFunds } from "./types.js";

export class RebalanceBot {
  constructor(
    readonly cfg: BotConfig,
    readonly solana: SolanaClient,
    readonly poolClient: DlmmPoolClient,
    readonly positions: PositionManager,
  ) {}

  tickOnce(): Effect.Effect<RebalanceDecision, DlmmError | TxError | RpcError | JupiterError | ConfigError> {
    return Effect.gen(this, function* () {
      yield* this.poolClient.refetch();
      const activeBinId = yield* this.poolClient.getActiveBinId();
      const summaries = yield* this.poolClient.getUserPositions(this.solana.owner);
      const empties = summaries.filter((s) => s.amountX === 0n && s.amountY === 0n);
      const funded = summaries.filter((s) => s.amountX !== 0n || s.amountY !== 0n);
      if (empties.length > 0) {
        const cleaned = yield* this.positions.closeEmptyPositions(
          empties.map((s) => s.address),
          this.cfg.dryRun,
        );
        for (const c of cleaned) yield* Effect.log(c);
      }
      const decision = this.positions.decide(funded, activeBinId);

      if (decision.kind === "Hold") {
        yield* Effect.log(`Hold: ${decision.reason}`);
        return decision;
      }

      yield* Effect.log(`Rebalance: ${decision.reason}`);
      const byAddress = new Map(funded.map((s) => [s.address, s] as const));
      const toClose: PositionSummary[] = [];
      for (const addr of decision.close) {
        const found = byAddress.get(addr);
        if (found) toClose.push(found);
      }
      const funds = sumFunds(toClose);
      if (this.cfg.dryRun) {
        const closed = yield* this.positions.closePositions(toClose, true);
        for (const c of closed) yield* Effect.log(c);
        const opened = yield* this.positions.openCentered(activeBinId, this.cfg, funds);
        yield* Effect.log(opened);
        return decision;
      }

      const closed = yield* this.positions.closePositions(toClose, false);
      for (const sig of closed) yield* Effect.log(`closed: ${sig}`);
      const opened = yield* this.positions.openCentered(activeBinId, this.cfg, funds);
      yield* Effect.log(`opened: ${opened}`);
      return decision;
    });
  }

  start(): Effect.Effect<never, never, never> {
    return Effect.forever(
      this.tickOnce().pipe(
        Effect.catchAll((cause) => Effect.logError(`tick failed: ${cause}`)),
        Effect.andThen(Effect.sleep(`${this.cfg.pollIntervalMs} millis`)),
      ),
    );
  }
}
