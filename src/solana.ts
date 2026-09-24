import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Effect } from "effect";
import type { BotConfig } from "./config.js";
import { ConfigError, RpcError } from "./errors.js";

export class SolanaClient {
  private constructor(
    readonly connection: Connection,
    readonly wallet: Keypair,
    readonly owner: PublicKey,
  ) {}

  static create(cfg: BotConfig): Effect.Effect<SolanaClient, ConfigError | RpcError> {
    return Effect.gen(function* () {
      let wallet: Keypair;
      try {
        wallet = Keypair.fromSecretKey(cfg.walletSecretKey);
      } catch {
        return yield* Effect.fail(new ConfigError({ reason: "WALLET_SECRET_KEY is not a valid keypair" }));
      }
      let connection: Connection;
      try {
        connection = new Connection(cfg.rpcUrl, cfg.commitment);
        yield* Effect.tryPromise({
          try: () => connection.getSlot(),
          catch: () => new RpcError({ reason: `cannot reach RPC ${cfg.rpcUrl}` }),
        });
      } catch {
        return yield* Effect.fail(new RpcError({ reason: `invalid RPC_URL ${cfg.rpcUrl}` }));
      }
      return new SolanaClient(connection, wallet, wallet.publicKey);
    });
  }
}
