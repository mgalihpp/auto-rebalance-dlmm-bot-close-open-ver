import type { BinRange } from "./types.js";

export class RebalanceStrategy {
  static buildRange(activeBinId: number, binsEachSide: number): BinRange {
    return { minBinId: activeBinId - binsEachSide, maxBinId: activeBinId + binsEachSide };
  }
}
