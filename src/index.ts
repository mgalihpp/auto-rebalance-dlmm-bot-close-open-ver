import "dotenv/config";
import { Effect } from "effect";
import { RebalanceBot } from "./bot.js";
import { BotConfig } from "./config.js";
import { DlmmPoolClient } from "./pool.js";
import { JupiterSwapClient } from "./jupiter.js";
import { PositionManager } from "./position.js";
import { SolanaClient } from "./solana.js";

const program = Effect.gen(function* () {
  const cfg = yield* BotConfig.loadFromEnv();
  yield* Effect.log(`dryRun=${cfg.dryRun} pool=${cfg.poolAddress} strategy=${cfg.strategyType}`);
  const solana = yield* SolanaClient.create(cfg);
  yield* Effect.log(`owner=${solana.owner.toBase58()}`);
  const poolClient = yield* DlmmPoolClient.load(solana, cfg.poolAddress);
  const jupiter = cfg.swapEnabled && cfg.jupiterApiKey ? new JupiterSwapClient(cfg.jupiterApiKey) : null;
  const positions = new PositionManager(poolClient, solana, cfg.binsEachSide, jupiter);
  const bot = new RebalanceBot(cfg, solana, poolClient, positions);
  yield* bot.start();
});

Effect.runPromise(program).catch((cause) => {
  console.error("bot exited:", cause);
  process.exit(1);
});
