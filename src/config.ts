import type { Commitment } from "@solana/web3.js";
import bs58 from "bs58";
import { Effect } from "effect";
import { solToLamports } from "./amounts.js";
import { ConfigError } from "./errors.js";
import type { Lamports, StrategyKind } from "./types.js";

function required(name: string): Effect.Effect<string, ConfigError> {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return Effect.fail(new ConfigError({ reason: `missing env ${name}` }));
  }
  return Effect.succeed(value);
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value;
}

function parseWalletSecret(raw: string): Effect.Effect<Uint8Array, ConfigError> {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed) || parsed.length !== 64) {
        return Effect.fail(
          new ConfigError({ reason: "WALLET_SECRET_KEY JSON array must hold 64 numbers" }),
        );
      }
      return Effect.succeed(Uint8Array.from(parsed as number[]));
    } catch {
      return Effect.fail(new ConfigError({ reason: "WALLET_SECRET_KEY is not valid JSON" }));
    }
  }
  try {
    const bytes = bs58.decode(trimmed);
    if (bytes.length !== 64) {
      return Effect.fail(
        new ConfigError({ reason: "WALLET_SECRET_KEY base58 must decode to 64 bytes" }),
      );
    }
    return Effect.succeed(bytes);
  } catch {
    return Effect.fail(
      new ConfigError({ reason: "WALLET_SECRET_KEY is neither base58 nor JSON array" }),
    );
  }
}

export class BotConfig {
  private constructor(
    readonly poolAddress: string,
    readonly walletSecretKey: Uint8Array,
    readonly deployLamports: Lamports,
    readonly binsEachSide: number,
    readonly strategyType: StrategyKind,
    readonly pollIntervalMs: number,
    readonly slippageBps: number,
    readonly rpcUrl: string,
    readonly dryRun: boolean,
    readonly commitment: Commitment,
    readonly jupiterApiKey: string | null,
    readonly swapEnabled: boolean,
    readonly telegramBotToken: string | null,
    readonly telegramChatIds: readonly string[],
    readonly telegramNotifyHold: boolean,
  ) {}

  static loadFromEnv(): Effect.Effect<BotConfig, ConfigError> {
    return Effect.gen(function* () {
      const rpcUrl = yield* required("RPC_URL");
      const walletRaw = yield* required("WALLET_SECRET_KEY");
      const poolRaw = yield* required("POOL_ADDRESS");

      let poolBytes: Uint8Array;
      try {
        poolBytes = bs58.decode(poolRaw.trim());
      } catch {
        return yield* Effect.fail(new ConfigError({ reason: "POOL_ADDRESS is not valid base58" }));
      }
      if (poolBytes.length !== 32) {
        return yield* Effect.fail(
          new ConfigError({ reason: "POOL_ADDRESS must decode to 32 bytes" }),
        );
      }

      const walletSecretKey = yield* parseWalletSecret(walletRaw);

      let deployLamports: Lamports;
      try {
        deployLamports = solToLamports(optional("DEPLOY_SOL", "0.1"));
      } catch {
        return yield* Effect.fail(new ConfigError({ reason: "DEPLOY_SOL is not a valid amount" }));
      }
      if (deployLamports <= 0n) {
        return yield* Effect.fail(new ConfigError({ reason: "DEPLOY_SOL must be > 0" }));
      }

      const binsEachSide = Number(optional("BINS_EACH_SIDE", "10"));
      if (!Number.isInteger(binsEachSide) || binsEachSide < 0 || binsEachSide > 35) {
        return yield* Effect.fail(
          new ConfigError({ reason: "BINS_EACH_SIDE must be an integer 0..35" }),
        );
      }

      const strategyRaw = optional("STRATEGY", "Spot");
      if (strategyRaw !== "Spot" && strategyRaw !== "BidAsk" && strategyRaw !== "Curve") {
        return yield* Effect.fail(
          new ConfigError({ reason: "STRATEGY must be Spot, BidAsk, or Curve" }),
        );
      }

      const pollIntervalMs = Number(optional("POLL_INTERVAL_MS", "30000"));
      if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 5000) {
        return yield* Effect.fail(
          new ConfigError({ reason: "POLL_INTERVAL_MS must be an integer >= 5000" }),
        );
      }

      const slippageBps = Number(optional("SLIPPAGE_BPS", "100"));
      if (!Number.isInteger(slippageBps) || slippageBps < 0) {
        return yield* Effect.fail(
          new ConfigError({ reason: "SLIPPAGE_BPS must be a non-negative integer" }),
        );
      }

      const dryRun = optional("DRY_RUN", "true").toLowerCase() !== "false";

      const jupiterRaw = optional("JUPITER_API_KEY", "").trim();
      const jupiterApiKey = jupiterRaw === "" ? null : jupiterRaw;
      const swapEnabled = optional("SWAP_ENABLED", "true").toLowerCase() !== "false";

      const commitmentRaw = optional("COMMITMENT", "confirmed");
      if (
        commitmentRaw !== "confirmed" &&
        commitmentRaw !== "finalized" &&
        commitmentRaw !== "processed"
      ) {
        return yield* Effect.fail(
          new ConfigError({ reason: "COMMITMENT must be confirmed, finalized, or processed" }),
        );
      }

      const telegramRaw = optional("TELEGRAM_BOT_TOKEN", "").trim();
      const telegramBotToken = telegramRaw === "" ? null : telegramRaw;
      const telegramChatIds = optional("TELEGRAM_CHAT_ID", "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      const telegramNotifyHold = optional("TELEGRAM_NOTIFY_HOLD", "false").toLowerCase() === "true";

      return new BotConfig(
        poolRaw.trim(),
        walletSecretKey,
        deployLamports,
        binsEachSide,
        strategyRaw,
        pollIntervalMs,
        slippageBps,
        rpcUrl.trim(),
        dryRun,
        commitmentRaw,
        jupiterApiKey,
        swapEnabled,
        telegramBotToken,
        telegramChatIds,
        telegramNotifyHold,
      );
    });
  }
}
