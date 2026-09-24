# Auto Rebalance DLMM Bot (close/open)

Single-pool Meteora DLMM bot. Each tick it refetches state, compares the
active bin against the wallet position, and rebalances when out of range:
close the stale position, open one centered position around the active bin.

## Install

```sh
npm install
cp .env.example .env
```

Fill `.env`, then typecheck with `npm run check`.

## Run order

1. Keep `DRY_RUN=true`. Start with devnet RPC and a devnet pool.
2. `npm run dev`. Expect `Hold: ...` or `Rebalance: ...` lines plus
   `dry-run:close:...` / `dry-run:open:[min,max]` lines. No transaction
   is sent in dry-run mode.
3. Only then point at mainnet with a funded wallet and `DRY_RUN=false`.

## Reading the log

- `Hold: active bin N inside [a, b]` does nothing.
- `Rebalance: active bin N outside [a, b]` closes the listed positions
  and opens `[N-10, N+10]` (width from `BINS_EACH_SIDE`, `0` opens `[N, N]`).
- `Rebalance: N positions, consolidating to one` closes everything, opens one.
- `dry-run:close-empty:...` removes a zero-balance shell left from an
  earlier close, then the tick continues on funded positions.
- `tick failed: ...` never kills the loop. The bot sleeps and retries.

## Telegram

Opsional, tanpa dependency tambahan (pakai Bot API + long-polling).

1. Chat ke `@BotFather` → `/newbot` → copy token ke `TELEGRAM_BOT_TOKEN`.
2. Chat ke bot kamu → `/start`. Cari chat id via
   `https://api.telegram.org/bot<TOKEN>/getUpdates` atau `@userinfobot`,
   isi ke `TELEGRAM_CHAT_ID` (boleh koma untuk banyak id).
3. Restart bot. Harusnya dapat pesan `🤖 bot online`.

Perintah di Telegram (atau tombol inline):

- `/status` — RUNNING/PAUSED, active bin, daftar posisi funded.
- `/position` — detail semua posisi (address, range, x/y).
- `/pause` — pause: tick dilewati (`Hold: paused`), tidak ada tx, tidak ada RPC refetch.
- `/resume` — lanjutkan rebalance.
- `/tick` — paksa 1 tick sekarang (ditolak kalau paused).
- `/help` — bantuan.

Notifikasi otomatis ke semua chat terdaftar: bot online, tiap `Rebalance`
(plus open range + address yang di-close), dan tiap `tick failed`.
Isi `TELEGRAM_NOTIFY_HOLD=true` kalau mau tiap `Hold` juga dikirim (spammy).
Tanpa `TELEGRAM_CHAT_ID`, siapa pun yang `/start` akan terdaftar — isi untuk privat.

## Limits

- Rebalance reuses withdrawn capital (`src/position.ts`). Close withdraws
  X+Y plus claimed fees, then open deposits re-centered. Range 1 bin with
  all-SOL funds deposits as-is with no swap. Range 1 bin with single-sided
  non-SOL funds swaps all to SOL via Jupiter then deposits SOL. Wider
  ranges with single-sided funds swap half then deposit both sides, mixed
  funds deposit as-is. Needs `JUPITER_API_KEY` when live except for
  all-SOL 1 bin opens. `DEPLOY_SOL` funds only the first open.
- One pool per process. Run one process per pool for more.
