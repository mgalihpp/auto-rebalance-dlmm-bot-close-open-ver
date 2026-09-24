export type Lamports = bigint & { readonly __brand: "Lamports" };

export type PubkeyString = string & { readonly __brand: "PubkeyString" };

export type StrategyKind = "Spot" | "BidAsk" | "Curve";

export interface BinRange {
  readonly minBinId: number;
  readonly maxBinId: number;
}

export interface PositionSummary {
  readonly address: string;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly amountX: bigint;
  readonly amountY: bigint;
}

export interface WithdrawnFunds {
  readonly x: bigint;
  readonly y: bigint;
}

export function sumFunds(positions: readonly PositionSummary[]): WithdrawnFunds {
  let x = 0n;
  let y = 0n;
  for (const p of positions) {
    x += p.amountX;
    y += p.amountY;
  }
  return { x, y };
}

export type PositionState =
  | { readonly kind: "NoPosition" }
  | {
      readonly kind: "InRange";
      readonly position: PositionSummary;
      readonly activeBinId: number;
    }
  | {
      readonly kind: "OutOfRangeBelow" | "OutOfRangeAbove";
      readonly position: PositionSummary;
      readonly activeBinId: number;
    }
  | { readonly kind: "MultiplePositions"; readonly positions: readonly PositionSummary[] };

export type RebalanceDecision =
  | { readonly kind: "Hold"; readonly reason: string }
  | {
      readonly kind: "Rebalance";
      readonly reason: string;
      readonly close: readonly string[];
      readonly openRange: BinRange;
    };

export function toPositionState(
  positions: readonly PositionSummary[],
  activeBinId: number,
): PositionState {
  if (positions.length === 0) return { kind: "NoPosition" };
  const first = positions[0] as PositionSummary;
  if (positions.length > 1) return { kind: "MultiplePositions", positions };
  if (activeBinId < first.lowerBinId)
    return { kind: "OutOfRangeBelow", position: first, activeBinId };
  if (activeBinId > first.upperBinId)
    return { kind: "OutOfRangeAbove", position: first, activeBinId };
  return { kind: "InRange", position: first, activeBinId };
}
