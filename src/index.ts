import "dotenv/config";
import { Effect } from "effect";
import { BotState, RebalanceBot } from "./bot.js";
import { BotConfig } from "./config.js";
import { DlmmPoolClient } from "./pool.js";
import { JupiterSwapClient } from "./jupiter.js";
import { PositionManager } from "./position.js";
import { SolanaClient } from "./solana.js";
import { TelegramNotifier, startTelegramPolling } from "./telegram.js";

const program = Effect.gen(function* () {
  const cfg = yield* BotConfig.loadFromEnv();
  yield* Effect.log(`dryRun=${cfg.dryRun} pool=${cfg.poolAddress} strategy=${cfg.strategyType}`);
  const solana = yield* SolanaClient.create(cfg);
  yield* Effect.log(`owner=${solana.owner.toBase58()}`);
  const poolClient = yield* DlmmPoolClient.load(solana, cfg.poolAddress);
  const jupiter = cfg.swapEnabled && cfg.jupiterApiKey ? new JupiterSwapClient(cfg.jupiterApiKey) : null;
  const positions = new PositionManager(poolClient, solana, cfg.binsEachSide, jupiter);
  const state = new BotState();
  const bot = new RebalanceBot(cfg, solana, poolClient, positions, state);

  const notifier = cfg.telegramBotToken
    ? new TelegramNotifier(cfg.telegramBotToken, cfg.telegramChatIds)
    : null;
  const notify = notifier ? ((msg: string) => notifier.broadcast(msg)) : undefined;

  if (notifier) {
    if (cfg.telegramChatIds.length === 0) {
      yield* Effect.logWarning(
        "TELEGRAM_CHAT_ID kosong: siapa pun yang /start ke bot akan terdaftar. Isi dengan chat id kamu agar privat.",
      );
    }

    const getStatus = (): Effect.Effect<string, never, never> =>
      Effect.gen(function* () {
        const activeBinId = yield* poolClient.getActiveBinId();
        const summaries = yield* poolClient.getUserPositions(solana.owner);
        const funded = summaries.filter((s) => s.amountX !== 0n || s.amountY !== 0n);
        const lines = funded.length === 0
          ? ["(tidak ada posisi funded)"]
          : funded.map(
            (p) =>
              `• ${p.address.slice(0, 8)}… [${p.lowerBinId}, ${p.upperBinId}] x=${p.amountX} y=${p.amountY}`,
          );
        return (
          `${state.isPaused ? "⏸ PAUSED" : "▶️ RUNNING"} | dryRun=${cfg.dryRun} | active=${activeBinId}\n` +
          `pool=${cfg.poolAddress}\n` +
          `posisi (${funded.length}):\n${lines.join("\n")}`
        );
      }).pipe(Effect.catchAll((cause) => Effect.succeed(`⚠️ status gagal: ${String(cause)}`)));

    const getPosition = (): Effect.Effect<string, never, never> =>
      Effect.gen(function* () {
        const summaries = yield* poolClient.getUserPositions(solana.owner);
        if (summaries.length === 0) return "👛 belum ada posisi di pool ini.";
        return (
          `👛 ${summaries.length} posisi:\n` +
          summaries
            .map(
              (p) =>
                `• ${p.address}\n  range [${p.lowerBinId}, ${p.upperBinId}] x=${p.amountX} y=${p.amountY}`,
            )
            .join("\n")
        );
      }).pipe(Effect.catchAll((cause) => Effect.succeed(`⚠️ position gagal: ${String(cause)}`)));

    const pause = (): Effect.Effect<string, never, never> =>
      Effect.gen(function* () {
        if (state.isPaused) return "⏸ sudah paused.";
        state.pause();
        yield* Effect.log("bot paused via telegram");
        return "⏸ bot di-pause. Tick dilewati sampai /resume.";
      });

    const resume = (): Effect.Effect<string, never, never> =>
      Effect.gen(function* () {
        if (!state.isPaused) return "▶️ bot sudah running.";
        state.resume();
        yield* Effect.log("bot resumed via telegram");
        return "▶️ bot resumed. Rebalance aktif lagi.";
      });

    const tickNow = (): Effect.Effect<string, never, never> =>
      Effect.gen(function* () {
        if (state.isPaused) return "⏸ masih paused — /resume dulu untuk tick.";
        const decision = yield* bot.tickOnce();
        if (decision.kind === "Hold") return `Hold: ${decision.reason}`;
        return (
          `🔄 Rebalance: ${decision.reason}\n` +
          `close: ${decision.close.join(", ") || "-"}\n` +
          `open: [${decision.openRange.minBinId}, ${decision.openRange.maxBinId}]`
        );
      }).pipe(Effect.catchAll((cause) => Effect.succeed(`⚠️ tick gagal: ${String(cause)}`)));

    yield* Effect.forkDaemon(
      startTelegramPolling(notifier.token, {
        allowedChatIds: cfg.telegramChatIds,
        notifier,
        handlers: { getStatus, getPosition, pause, resume, tickNow },
      }),
    );

    yield* notifier.broadcast(
      `🤖 bot online\npool=${cfg.poolAddress}\ndryRun=${cfg.dryRun}\nKirim /status /pause /resume /position /tick`,
    );
  } else {
    yield* Effect.log("telegram disabled: isi TELEGRAM_BOT_TOKEN untuk mengaktifkan.");
  }

  yield* bot.start({ notify, notifyHold: cfg.telegramNotifyHold });
});

Effect.runPromise(program).catch((cause) => {
  console.error("bot exited:", cause);
  process.exit(1);
});
