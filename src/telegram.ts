import { Effect } from "effect";
import { reasonOf } from "./errors.js";

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly chat: { readonly id: number | string };
    readonly text?: string;
  };
  readonly callback_query?: {
    readonly id: string;
    readonly data?: string;
    readonly message?: { readonly chat: { readonly id: number | string } };
  };
}

interface GetUpdatesResponse {
  readonly ok: boolean;
  readonly result: readonly TelegramUpdate[];
}

const MAIN_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "⏸ Pause", callback_data: "pause" },
      { text: "▶️ Resume", callback_data: "resume" },
    ],
    [
      { text: "📊 Status", callback_data: "status" },
      { text: "👛 Position", callback_data: "position" },
    ],
  ],
};

export const HELP_TEXT =
  "🤖 DLMM Rebalance Bot\n\n" +
  "/status — status bot (running/paused, active bin, posisi)\n" +
  "/position — detail posisi wallet di pool ini\n" +
  "/pause — pause: tick dilewati, tidak ada tx\n" +
  "/resume — lanjutkan lagi\n" +
  "/tick — paksa 1 tick sekarang\n" +
  "/help — tampilkan bantuan ini";

export class TelegramNotifier {
  private readonly seen = new Set<string>();

  constructor(
    readonly token: string,
    readonly defaultChatIds: readonly string[],
  ) {
    for (const id of defaultChatIds) this.seen.add(id);
  }

  remember(chatId: string): void {
    this.seen.add(chatId);
  }

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  sendTo(chatId: string, text: string): Effect.Effect<void, never, never> {
    return Effect.tryPromise({
      try: () =>
        fetch(this.url("sendMessage"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
            reply_markup: MAIN_KEYBOARD,
          }),
        }).then(async (res) => {
          if (!res.ok) throw new Error(`telegram sendMessage HTTP ${res.status}`);
        }),
      catch: (cause) => new Error(`telegram send failed: ${reasonOf(cause)}`),
    }).pipe(
      Effect.catchAll((cause) => Effect.logWarning(String(cause))),
      Effect.asVoid,
    );
  }

  broadcast(text: string): Effect.Effect<void, never, never> {
    return Effect.gen(this, function* () {
      if (this.seen.size === 0) {
        yield* Effect.log("telegram broadcast skipped: no known chat id (isi TELEGRAM_CHAT_ID atau /start dulu)");
        return;
      }
      for (const id of this.seen) {
        yield* this.sendTo(id, text);
      }
    });
  }
}

export interface TelegramHandlers {
  readonly getStatus: () => Effect.Effect<string, never, never>;
  readonly getPosition: () => Effect.Effect<string, never, never>;
  readonly pause: () => Effect.Effect<string, never, never>;
  readonly resume: () => Effect.Effect<string, never, never>;
  readonly tickNow: () => Effect.Effect<string, never, never>;
}

export interface TelegramPollingOptions {
  readonly allowedChatIds: readonly string[];
  readonly notifier: TelegramNotifier;
  readonly handlers: TelegramHandlers;
}

function normalizeCommand(raw: string): string {
  const first = raw.trim().split(/\s+/)[0] ?? "";
  const withoutBot = first.split("@")[0] ?? first;
  return withoutBot.toLowerCase();
}

function isAuthorized(allowed: readonly string[], chatId: string): boolean {
  if (allowed.length === 0) return true;
  return allowed.includes(chatId);
}

async function fetchUpdates(token: string, offset: number): Promise<readonly TelegramUpdate[]> {
  const url =
    `https://api.telegram.org/bot${token}/getUpdates` +
    `?offset=${offset}&timeout=30&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(35_000) });
  if (!res.ok) throw new Error(`telegram getUpdates HTTP ${res.status}`);
  const body = (await res.json()) as GetUpdatesResponse;
  if (!body.ok) throw new Error("telegram getUpdates ok=false");
  return body.result;
}

async function answerCallback(token: string, callbackId: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId }),
    });
  } catch {
    // best effort, abaikan
  }
}

export function startTelegramPolling(
  token: string,
  opts: TelegramPollingOptions,
): Effect.Effect<never, never, never> {
  const cursor = { offset: 0 };

  const handleText = (text: string): Effect.Effect<string, never, never> => {
    const cmd = normalizeCommand(text);
    switch (cmd) {
      case "/start":
      case "start":
      case "/help":
      case "help":
      case "menu":
      case "/menu":
        return Effect.succeed(HELP_TEXT);
      case "/pause":
      case "pause":
      case "⏸":
      case "⏸pause":
        return opts.handlers.pause();
      case "/resume":
      case "resume":
      case "▶️":
      case "▶":
      case "▶resume":
        return opts.handlers.resume();
      case "/status":
      case "status":
      case "📊":
        return opts.handlers.getStatus();
      case "/position":
      case "/positions":
      case "position":
      case "posisi":
      case "/posisi":
      case "👛":
        return opts.handlers.getPosition();
      case "/tick":
      case "/ticknow":
      case "tick":
        return opts.handlers.tickNow();
      default:
        return Effect.succeed(`❓ perintah tidak dikenal: ${text}\n\n${HELP_TEXT}`);
    }
  };

  const oneBatch: Effect.Effect<void, never, never> = Effect.gen(function* () {
    const updates = yield* Effect.tryPromise({
      try: () => fetchUpdates(token, cursor.offset),
      catch: (cause) => new Error(`getUpdates failed: ${reasonOf(cause)}`),
    }).pipe(Effect.catchAll((cause) => Effect.zipRight(Effect.logWarning(String(cause)), Effect.succeed([] as readonly TelegramUpdate[]))));

    for (const u of updates) {
      cursor.offset = Math.max(cursor.offset, u.update_id + 1);
      const callback = u.callback_query;
      const msg = u.message;
      if (callback) {
        const chatId = callback.message ? String(callback.message.chat.id) : null;
        const data = (callback.data ?? "").trim();
        yield* Effect.tryPromise({ try: () => answerCallback(token, callback.id), catch: () => new Error("answerCallback failed") }).pipe(
          Effect.catchAll(() => Effect.void),
        );
        if (!chatId) continue;
        if (!isAuthorized(opts.allowedChatIds, chatId)) {
          yield* Effect.logWarning(`telegram: unauthorized callback from ${chatId}`);
          yield* opts.notifier.sendTo(chatId, "⛔ chat ini tidak diizinkan.");
          continue;
        }
        opts.notifier.remember(chatId);
        const reply = yield* handleText(data === "" ? "help" : data);
        yield* Effect.log(`telegram ${chatId} [button:${data}] -> ${reply.slice(0, 80)}`);
        yield* opts.notifier.sendTo(chatId, reply);
        continue;
      }
      if (msg?.text) {
        const chatId = String(msg.chat.id);
        if (!isAuthorized(opts.allowedChatIds, chatId)) {
          yield* Effect.logWarning(`telegram: unauthorized message from ${chatId}`);
          yield* opts.notifier.sendTo(chatId, "⛔ chat ini tidak diizinkan.");
          continue;
        }
        opts.notifier.remember(chatId);
        const reply = yield* handleText(msg.text);
        yield* Effect.log(`telegram ${chatId} [${msg.text.slice(0, 40)}] -> ${reply.slice(0, 80)}`);
        yield* opts.notifier.sendTo(chatId, reply);
      } else if (msg) {
        cursor.offset = Math.max(cursor.offset, u.update_id + 1);
      }
    }
  }).pipe(Effect.catchAll((cause) => Effect.logWarning(`telegram batch failed: ${String(cause)}`)));

  return Effect.zipRight(
    Effect.log("telegram polling started (commands: /status /position /pause /resume /tick)"),
    Effect.forever(oneBatch),
  );
}
