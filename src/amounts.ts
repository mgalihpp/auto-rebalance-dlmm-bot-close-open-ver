import BN from "bn.js";
import type { Lamports } from "./types.js";

const LAMPORTS_PER_SOL = 1_000_000_000n;

export function solToLamports(input: string): Lamports {
  const trimmed = input.trim();
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(trimmed);
  if (!match) throw new Error(`invalid SOL amount: ${input}`);
  const whole = BigInt(match[1] as string);
  const frac = (match[2] ?? "").padEnd(9, "0");
  return (whole * LAMPORTS_PER_SOL + BigInt(frac)) as Lamports;
}

// Deploy SOL dipakai single-sided penuh di sisi SOL pool.
// splitDeploy lama dihapus karena membagi lamports mentah ke dua token
// yang desimalnya beda, sehingga 0.05 SOL hanya keluar 0.025 SOL.
export function solSingleSided(
  total: Lamports,
  solIsX: boolean,
): { readonly x: BN; readonly y: BN } {
  const amount = new BN(total.toString());
  const zero = new BN(0);
  return solIsX ? { x: amount, y: zero } : { x: zero, y: amount };
}
