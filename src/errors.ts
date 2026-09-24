import { Data } from "effect";

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly reason: string;
}> {
  get message(): string {
    return this.reason;
  }
}

export class RpcError extends Data.TaggedError("RpcError")<{
  readonly reason: string;
}> {
  get message(): string {
    return this.reason;
  }
}

export class DlmmError extends Data.TaggedError("DlmmError")<{
  readonly reason: string;
}> {
  get message(): string {
    return this.reason;
  }
}

export class TxError extends Data.TaggedError("TxError")<{
  readonly reason: string;
}> {
  get message(): string {
    return this.reason;
  }
}

export class JupiterError extends Data.TaggedError("JupiterError")<{
  readonly reason: string;
}> {
  get message(): string {
    return this.reason;
  }
}

export function reasonOf(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return String(cause);
}
