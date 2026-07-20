/**
 * Krishi Munafa — Cost Escalation Utility
 *
 * The Maharashtra DES cost-of-cultivation survey data is dated to a
 * specific reference year (2018-19 for the current dataset). Costs
 * measured then don't reflect today's prices, so every cost figure
 * needs escalating forward.
 *
 * This is deliberately a small pure function, not a hardcoded
 * multiplier baked into the data files — the rate and the years are
 * parameters, so it can be recalculated as data ages, or replaced with
 * a real crop-input price index (CACP's Composite Input Price Index)
 * if that becomes available, without touching every dataset by hand.
 *
 * Default rate: 5% per year, compounded — a general agricultural cost
 * escalation assumption, not derived from a specific index. This is a
 * simplification: real input inflation varies by category (labour vs
 * fertilizer vs seed) and by year, and a single flat rate will not
 * track any of them precisely. Treat escalated figures as reasonable
 * order-of-magnitude estimates, not precise projections.
 */

export interface EscalationParams {
  baseYear: number;
  targetYear: number;
  annualRatePercent?: number; // default 5
}

export function escalationFactor({ baseYear, targetYear, annualRatePercent = 5 }: EscalationParams): number {
  const years = targetYear - baseYear;
  if (years <= 0) return 1;
  const rate = annualRatePercent / 100;
  return Math.pow(1 + rate, years);
}

export function escalateValue(baseValue: number, params: EscalationParams): number {
  return baseValue * escalationFactor(params);
}
