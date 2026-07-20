/**
 * Krishi Munafa — Portfolio Engine
 *
 * Treats land allocation across multiple crops as a portfolio problem:
 * each crop has an expected profit-per-acre and a volatility (spread),
 * derived from its min-max range. We look for the land split that
 * maximizes profit per unit of risk (a Sharpe-ratio-style score), not
 * just raw expected profit — this is what "always default to the
 * risk-adjusted/safer ranking" (agreed in scoping) means mathematically.
 *
 * KNOWN LIMITATION, stated plainly: this assumes crops are uncorrelated
 * with each other. In reality, a bad monsoon can hurt several rainfed
 * crops in the same district in the same season together — true
 * portfolio risk is somewhat understated here. Fixing this needs
 * historical yield/price covariance data across crops, which we don't
 * have yet. Flagged as a v1 limitation, not silently assumed away.
 */

import { calculateCropResult, CropInput } from './profitEngine';

export interface PortfolioCropCandidate {
  cropName: string;
  familyKey: string;
  /** Which cropping season(s) this crop is grown in -- 'Kharif' | 'Rabi' | 'Summer' | 'Perennial'. Optional for backward compatibility with callers that don't do season-aware planning. */
  seasons?: string[];
  input: Omit<CropInput, 'acresAllocated'>;
}

export interface PerAcreStats {
  cropName: string;
  familyKey: string;
  meanProfitPerAcre: number;
  stdevProfitPerAcre: number;
  varianceProfitPerAcre: number;
  /** False if this crop's price only had a single realized data point (no real range) — see CropBaseline.priceRangeMeasured. */
  riskMeasured: boolean;
}

/**
 * Converts a crop's min-max profit range into mean/variance, assuming a
 * uniform distribution across the range. This is a simplifying
 * assumption for tractability, not a claim about the true shape of
 * price/yield variation — flagged here rather than presented as fact.
 */
export function getPerAcreStats(candidate: PortfolioCropCandidate): PerAcreStats {
  const result = calculateCropResult({ ...candidate.input, acresAllocated: 1 });
  const mean = (result.profitMin + result.profitMax) / 2;
  const range = result.profitMax - result.profitMin;
  const variance = Math.pow(range, 2) / 12; // variance of Uniform(a,b) = (b-a)^2/12
  return {
    cropName: candidate.cropName,
    familyKey: candidate.familyKey,
    meanProfitPerAcre: mean,
    stdevProfitPerAcre: Math.sqrt(variance),
    varianceProfitPerAcre: variance,
    riskMeasured: candidate.input.baseline.priceRangeMeasured ?? true,
  };
}

export type PortfolioWeights = Record<string, number>; // fraction of total land, sums to 1

export type RiskMeasurement = 'measured' | 'partial' | 'unmeasured';

export interface PortfolioResult {
  cropNames: string[];
  weights: PortfolioWeights;
  expectedProfit: number;
  stdevProfit: number;
  riskAdjustedScore: number; // expectedProfit / stdevProfit — higher is better
  /**
   * Whether stdevProfit above reflects real observed price variation
   * ('measured'), a mix of measured and unmeasured crops ('partial'), or
   * no real variance data at all ('unmeasured' — every crop in this
   * combo only had a single price point, so a near-zero stdev here means
   * "we don't know," not "this is genuinely stable").
   */
  riskMeasurement: RiskMeasurement;
}

// Practical farmability bounds: don't recommend a sliver too small to
// manage, don't let the math quietly recommend a monocrop either.
const MIN_WEIGHT = 0.15;
const MAX_WEIGHT = 0.70;

/**
 * Tangency-portfolio-style weighting. For uncorrelated assets, the
 * maximum risk-adjusted-return portfolio has weight proportional to
 * mean/variance per asset (the classic mean-variance result with a
 * diagonal covariance matrix). Negative-mean crops are excluded (no
 * shorting a crop), then bounds are enforced via iterative clip +
 * renormalize — a heuristic projection, not a guaranteed global optimum,
 * but adequate for 1-3 crop combinations.
 */
export function optimizeWeights(stats: PerAcreStats[]): PortfolioWeights {
  if (stats.length === 1) return { [stats[0].cropName]: 1 };

  const raw: Record<string, number> = {};
  let total = 0;
  for (const s of stats) {
    const score = Math.max(s.meanProfitPerAcre, 0) / (s.varianceProfitPerAcre || 1);
    raw[s.cropName] = score;
    total += score;
  }
  if (total === 0) {
    const equal = 1 / stats.length;
    return Object.fromEntries(stats.map((s) => [s.cropName, equal]));
  }

  const weights: Record<string, number> = {};
  for (const s of stats) weights[s.cropName] = raw[s.cropName] / total;

  for (let pass = 0; pass < 8; pass++) {
    let excess = 0;
    let freeCount = 0;
    for (const name in weights) {
      if (weights[name] > MAX_WEIGHT) {
        excess += weights[name] - MAX_WEIGHT;
        weights[name] = MAX_WEIGHT;
      } else if (weights[name] < MIN_WEIGHT) {
        excess -= MIN_WEIGHT - weights[name];
        weights[name] = MIN_WEIGHT;
      } else {
        freeCount++;
      }
    }
    if (Math.abs(excess) < 1e-6 || freeCount === 0) break;
    const adjust = excess / freeCount;
    for (const name in weights) {
      if (weights[name] > MIN_WEIGHT && weights[name] < MAX_WEIGHT) {
        weights[name] += adjust;
      }
    }
  }

  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  for (const name in weights) weights[name] /= sum;
  return weights;
}

export function evaluatePortfolio(
  stats: PerAcreStats[],
  weights: PortfolioWeights,
  totalAcres: number
): PortfolioResult {
  let expectedProfitPerAcre = 0;
  let variancePerAcre = 0;
  for (const s of stats) {
    const w = weights[s.cropName] || 0;
    expectedProfitPerAcre += w * s.meanProfitPerAcre;
    variancePerAcre += Math.pow(w, 2) * s.varianceProfitPerAcre;
  }
  const expectedProfit = expectedProfitPerAcre * totalAcres;
  const stdevProfit = Math.sqrt(variancePerAcre) * totalAcres;

  const measuredCount = stats.filter((s) => s.riskMeasured).length;
  const riskMeasurement: RiskMeasurement =
    measuredCount === stats.length ? 'measured' : measuredCount === 0 ? 'unmeasured' : 'partial';

  return {
    cropNames: stats.map((s) => s.cropName),
    weights,
    expectedProfit,
    stdevProfit,
    riskAdjustedScore: stdevProfit > 0 ? expectedProfit / stdevProfit : expectedProfit,
    riskMeasurement,
  };
}

function combinations<T>(arr: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (arr.length < size) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, size - 1).map((c) => [first, ...c]);
  const withoutFirst = combinations(rest, size);
  return [...withFirst, ...withoutFirst];
}

export interface RankedPortfolio extends PortfolioResult {
  familyKeys: string[];
  cv: number; // coefficient of variation = stdev/mean — RELATIVE risk, doesn't
              // penalize crops just for operating at bigger absolute rupee scale
}

/**
 * Enumerates crop combinations of size minCrops..maxCrops from the
 * viable candidate list and evaluates each — but does NOT collapse them
 * to one "best" ranking here. riskAdjustedScore (mean/stdev in absolute
 * rupees) is one lens; it systematically favors low-absolute-scale
 * crops even when their RELATIVE risk (cv) is no better — see
 * decisionShortlist.ts, which is where multiple axes (earning,
 * stability via cv, soil, water) get combined into a shortlist instead
 * of a single winner. Brute-force over combinations is fine here — with
 * a realistic per-district crop list (~15-20) and maxCrops capped at 3,
 * this is a few hundred combinations at most.
 */
export function evaluateAllCombinations(
  candidates: PortfolioCropCandidate[],
  totalAcres: number,
  options: { minCrops?: number; maxCrops?: number } = {}
): RankedPortfolio[] {
  const minCrops = options.minCrops ?? 1;
  const maxCrops = Math.min(options.maxCrops ?? 3, candidates.length);

  const results: RankedPortfolio[] = [];
  for (let size = minCrops; size <= maxCrops; size++) {
    for (const combo of combinations(candidates, size)) {
      const stats = combo.map(getPerAcreStats);
      const weights = optimizeWeights(stats);
      const evaluated = evaluatePortfolio(stats, weights, totalAcres);
      results.push({
        ...evaluated,
        familyKeys: combo.map((c) => c.familyKey),
        cv: evaluated.expectedProfit > 0 ? evaluated.stdevProfit / evaluated.expectedProfit : Infinity,
      });
    }
  }
  return results;
}

/**
 * Backward-compatible convenience wrapper — sorts by the absolute-rupee
 * risk-adjusted score alone. Kept for cases that genuinely want that one
 * lens (e.g. internal rotation-year comparisons), but user-facing
 * recommendations should go through decisionShortlist.ts instead of
 * treating this ordering as "the answer."
 */
export function rankPortfolios(
  candidates: PortfolioCropCandidate[],
  totalAcres: number,
  options: { minCrops?: number; maxCrops?: number; topN?: number } = {}
): RankedPortfolio[] {
  const results = evaluateAllCombinations(candidates, totalAcres, options);
  results.sort((a, b) => b.riskAdjustedScore - a.riskAdjustedScore);
  return results.slice(0, options.topN ?? 5);
}
