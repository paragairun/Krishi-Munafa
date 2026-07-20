/**
 * Krishi Munafa — Profit Calculation Engine
 *
 * Pure functions, no framework/UI dependency, so this can be unit tested
 * and reused server-side (Edge Function) or client-side identically.
 */

export type Methodology = 'conventional' | 'organic' | 'natural_farming' | 'integrated';
export type IrrigationType = 'rainfed' | 'canal' | 'borewell' | 'drip' | 'sprinkler';

export interface CropBaseline {
  yieldMinQtlPerAcre: number;
  yieldMaxQtlPerAcre: number;
  priceMinPerQtl: number;
  priceMaxPerQtl: number;
  costSeedPerAcre: number;
  costFertilizerPerAcre: number;
  costPesticidePerAcre: number;
  costLabourPerAcre: number;
  costIrrigationPerAcre: number;
  costOtherPerAcre: number;
  source: string;
  verified: boolean;
  /**
   * True only if priceMin/priceMax come from a genuine observed range
   * (e.g. real district-to-district price spread, or live mandi min/max).
   * False if the range is an ASSUMED band around a single realized price
   * point (see the data-build step for how that band is derived — e.g.
   * an average CV taken from crops that do have real ranges), rather
   * than a real measurement. Defaults to true for backward compatibility
   * with earlier test datasets that always had a real band — new
   * data-building code should set this explicitly.
   * IMPORTANT: this flag must never be used to decide whether a crop
   * contributes risk to a portfolio (it always should, even when
   * assumed) — it exists only so callers can show a confidence caveat.
   * An earlier version conflated "unmeasured" with "zero variance,"
   * which made unmeasured-risk crops look falsely safe.
   */
  priceRangeMeasured?: boolean;
}

export interface MethodologyMultiplier {
  costMultiplier: number;
  yieldMultiplier: number;
  priceMultiplier: number;
}

export interface IrrigationMultiplier {
  yieldMultiplier: number;
  costPerAcre: number;
}

export interface CropInput {
  cropName: string;
  acresAllocated: number;      // this crop's share of total land, in acres
  harvestsPerYear: number;
  methodology: Methodology;
  irrigation: IrrigationType;
  climateRiskIndex: number;    // 0 (stable) - 1 (high risk), from district data
  baseline: CropBaseline;
  methodologyMultiplier: MethodologyMultiplier;
  irrigationMultiplier: IrrigationMultiplier;
  // if live mandi data is available, it overrides baseline price (not yield/cost)
  livePriceMinPerQtl?: number;
  livePriceMaxPerQtl?: number;
}

export interface CropResult {
  cropName: string;
  yieldMinQtl: number;
  yieldMaxQtl: number;
  priceMinPerQtl: number;
  priceMaxPerQtl: number;
  totalCost: number;
  revenueMin: number;
  revenueMax: number;
  profitMin: number;
  profitMax: number;
  usedLivePrice: boolean;
  dataVerified: boolean;
}

export interface FarmSummary {
  crops: CropResult[];
  totalProfitMin: number;
  totalProfitMax: number;
  targetEarning?: number;
  verdict: 'Recommended' | 'Marginal' | 'Not Recommended';
  anyUnverifiedData: boolean;
}

/**
 * Climate risk reduces the achievable yield toward the minimum end of the range.
 * A risk index of 0 leaves the yield range untouched; 1.0 compresses everything
 * toward yieldMin (worst case), since drought/flood-prone areas shouldn't be
 * shown optimistic maximums as if they were reliable.
 */
function applyClimateRisk(yieldMin: number, yieldMax: number, riskIndex: number) {
  const clampedRisk = Math.min(Math.max(riskIndex, 0), 1);
  const adjustedMax = yieldMax - (yieldMax - yieldMin) * clampedRisk * 0.5;
  return { min: yieldMin * (1 - clampedRisk * 0.15), max: adjustedMax };
}

export function calculateCropResult(input: CropInput): CropResult {
  const { baseline, methodologyMultiplier, irrigationMultiplier } = input;

  const riskAdjustedYield = applyClimateRisk(
    baseline.yieldMinQtlPerAcre,
    baseline.yieldMaxQtlPerAcre,
    input.climateRiskIndex
  );

  const yieldMinQtl =
    riskAdjustedYield.min *
    methodologyMultiplier.yieldMultiplier *
    irrigationMultiplier.yieldMultiplier *
    input.acresAllocated *
    input.harvestsPerYear;

  const yieldMaxQtl =
    riskAdjustedYield.max *
    methodologyMultiplier.yieldMultiplier *
    irrigationMultiplier.yieldMultiplier *
    input.acresAllocated *
    input.harvestsPerYear;

  const usedLivePrice = input.livePriceMinPerQtl != null && input.livePriceMaxPerQtl != null;
  const priceMinPerQtl =
    (usedLivePrice ? input.livePriceMinPerQtl! : baseline.priceMinPerQtl) *
    methodologyMultiplier.priceMultiplier;
  const priceMaxPerQtl =
    (usedLivePrice ? input.livePriceMaxPerQtl! : baseline.priceMaxPerQtl) *
    methodologyMultiplier.priceMultiplier;

  const costPerAcre =
    (baseline.costSeedPerAcre +
      baseline.costFertilizerPerAcre +
      baseline.costPesticidePerAcre +
      baseline.costLabourPerAcre +
      baseline.costOtherPerAcre) *
      methodologyMultiplier.costMultiplier +
    (baseline.costIrrigationPerAcre + irrigationMultiplier.costPerAcre);

  const totalCost = costPerAcre * input.acresAllocated * input.harvestsPerYear;

  const revenueMin = yieldMinQtl * priceMinPerQtl;
  const revenueMax = yieldMaxQtl * priceMaxPerQtl;

  return {
    cropName: input.cropName,
    yieldMinQtl,
    yieldMaxQtl,
    priceMinPerQtl,
    priceMaxPerQtl,
    totalCost,
    revenueMin,
    revenueMax,
    profitMin: revenueMin - totalCost,
    profitMax: revenueMax - totalCost,
    usedLivePrice,
    dataVerified: baseline.verified,
  };
}

export function calculateFarmSummary(crops: CropInput[], targetEarning?: number): FarmSummary {
  const results = crops.map(calculateCropResult);
  const totalProfitMin = results.reduce((sum, r) => sum + r.profitMin, 0);
  const totalProfitMax = results.reduce((sum, r) => sum + r.profitMax, 0);

  let verdict: FarmSummary['verdict'] = 'Marginal';
  if (targetEarning != null) {
    if (totalProfitMin >= targetEarning) verdict = 'Recommended';
    else if (totalProfitMax < 0.8 * targetEarning) verdict = 'Not Recommended';
    else verdict = 'Marginal';
  } else {
    // no explicit target — judge on whether it's profitable at all
    if (totalProfitMin > 0) verdict = 'Recommended';
    else if (totalProfitMax <= 0) verdict = 'Not Recommended';
    else verdict = 'Marginal';
  }

  return {
    crops: results,
    totalProfitMin,
    totalProfitMax,
    targetEarning,
    verdict,
    anyUnverifiedData: results.some((r) => !r.dataVerified),
  };
}
