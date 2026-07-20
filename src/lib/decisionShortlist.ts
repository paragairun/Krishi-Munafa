/**
 * Krishi Munafa — Decision Shortlist
 *
 * This is the module that actually makes the tool "decision support, not
 * a predictor": it deliberately does NOT compute one composite score and
 * pick a winner. It evaluates every viable land-split combination, then
 * surfaces the best option on each of several axes a farmer actually
 * cares about — separately, so the tradeoff is visible:
 *
 *   - Highest earning potential (accepting more swing)
 *   - Most stable income (lowest relative risk, via coefficient of
 *     variation — NOT absolute rupee variance, which unfairly penalizes
 *     high-value crops just for operating at bigger numbers)
 *   - Best for long-term soil health (rotation-rule aligned)
 *   - Most water-sustainable (least reliant on heavy-water crops)
 *   - A balanced option that does reasonably on all axes without being
 *     extreme on any
 *
 * If two axes point to the same combination, that's shown once with
 * both tags — which is itself useful information ("this option happens
 * to be both stable AND water-light").
 */

import {
  PortfolioCropCandidate,
  RankedPortfolio,
  evaluateAllCombinations,
} from './portfolioEngine';

const HEAVY_FEEDER_FAMILIES = ['cereal_grass', 'fiber', 'sugarcane', 'banana', 'spice_rhizome'];
const LEGUME_FAMILIES = ['legume', 'legume_oilseed'];

export type WaterIntensityLevel = 'very_high' | 'high' | 'medium_high' | 'medium' | 'low_medium' | 'low';

export interface WaterIntensityData {
  scale: Record<WaterIntensityLevel, number>;
  byCropName: Record<string, WaterIntensityLevel>;
  byFamilyFallback: Record<string, WaterIntensityLevel>;
}

export type SoilImpactLabel = 'replenishing' | 'neutral' | 'depleting';

export interface AnnotatedPortfolio extends RankedPortfolio {
  soilImpact: SoilImpactLabel;
  soilImpactNote: string;
  waterScore: number; // lower is better, ~1 (low) to 4 (very high)
  waterLabel: 'water-light' | 'moderate water use' | 'water-intensive';
  isMonocrop: boolean;
  diversificationNote: string | null;
}

export type ShortlistTag =
  | 'highest_earning'
  | 'most_stable'
  | 'best_soil_health'
  | 'most_water_sustainable'
  | 'balanced';

export interface ShortlistOption {
  tags: ShortlistTag[];
  headline: string;
  portfolio: AnnotatedPortfolio;
}

function soilImpact(comboFamilies: string[], priorFamilies: string[]): { label: SoilImpactLabel; note: string } {
  const repeatsPrior = comboFamilies.some((f) => priorFamilies.includes(f));
  const priorHeavy = priorFamilies.some((f) => HEAVY_FEEDER_FAMILIES.includes(f));
  const hasLegume = comboFamilies.some((f) => LEGUME_FAMILIES.includes(f));

  if (repeatsPrior) {
    return { label: 'depleting', note: 'Repeats a crop family grown last season — raises pest/disease and nutrient-depletion risk.' };
  }
  if (priorHeavy && hasLegume) {
    return { label: 'replenishing', note: 'Includes a nitrogen-fixing legume after a heavy-feeding season — helps restore soil nitrogen.' };
  }
  return { label: 'neutral', note: 'Does not repeat last season\'s crop family, but no strong soil-replenishing effect either.' };
}

function waterScore(
  comboFamilies: string[],
  cropNames: string[],
  weights: Record<string, number>,
  waterData: WaterIntensityData
): number {
  let score = 0;
  cropNames.forEach((name, i) => {
    const level =
      waterData.byCropName[name] ?? waterData.byFamilyFallback[comboFamilies[i]] ?? 'medium';
    score += (weights[name] || 0) * waterData.scale[level];
  });
  return score;
}

function waterLabel(score: number): AnnotatedPortfolio['waterLabel'] {
  if (score <= 1.6) return 'water-light';
  if (score <= 2.6) return 'moderate water use';
  return 'water-intensive';
}

function annotate(
  p: RankedPortfolio,
  priorFamilies: string[],
  waterData: WaterIntensityData
): AnnotatedPortfolio {
  const soil = soilImpact(p.familyKeys, priorFamilies);
  const wScore = waterScore(p.familyKeys, p.cropNames, p.weights, waterData);
  const isMonocrop = p.cropNames.length === 1;
  return {
    ...p,
    soilImpact: soil.label,
    soilImpactNote: soil.note,
    waterScore: wScore,
    waterLabel: waterLabel(wScore),
    isMonocrop,
    diversificationNote: isMonocrop
      ? 'This plan puts all your land into a single crop. It doesn\'t repeat what you grew last season, but putting 100% of your land behind one crop means full exposure to that crop\'s price swings this year, and no within-season diversification. If you lean on this choice, don\'t default to the same crop again next season — alternate with a different family, or split land next time even if the math favors concentration.'
      : null,
  };
}

/**
 * Builds the multi-axis shortlist. Returns 3-5 options, each tagged with
 * why it's included, rather than a single ranked "best" answer.
 */
export function buildShortlist(
  candidates: PortfolioCropCandidate[],
  totalAcres: number,
  priorFamilies: string[],
  waterData: WaterIntensityData,
  options: { maxCrops?: number } = {}
): ShortlistOption[] {
  const all = evaluateAllCombinations(candidates, totalAcres, { maxCrops: options.maxCrops ?? 3 });
  if (all.length === 0) return [];

  const annotated = all.map((p) => annotate(p, priorFamilies, waterData));

  const byEarning = [...annotated].sort((a, b) => b.expectedProfit - a.expectedProfit);
  // Sort by actual relative risk (CV). We used to hard-prefer any
  // "measured" combo over any "unmeasured" one here, to stop unmeasured
  // crops (which briefly had zero fabricated variance) from looking
  // falsely safe. That overcorrected: it could crown an objectively
  // worse combo -- lower profit, depleting soil, water-intensive --
  // "most stable" purely because it had real data, even against options
  // that beat it on every other axis. The actual fix is upstream: crops
  // without a measured price range now carry a realistic ASSUMED
  // uncertainty (derived from the crops we do have real ranges for)
  // instead of zero, so CV is no longer artificially deflated for them.
  // That means sorting on CV directly is trustworthy again --
  // riskMeasurement stays as a caveat label, not a sort override.
  const byStability = [...annotated].sort((a, b) => a.cv - b.cv);
  const bySoil = [...annotated]
    .filter((p) => p.soilImpact !== 'depleting')
    .sort((a, b) => {
      const rank = { replenishing: 0, neutral: 1, depleting: 2 };
      return rank[a.soilImpact] - rank[b.soilImpact] || b.expectedProfit - a.expectedProfit;
    });
  const byWater = [...annotated].sort((a, b) => a.waterScore - b.waterScore || b.expectedProfit - a.expectedProfit);

  // Balanced: normalize each axis to a 0-1 percentile rank and average them —
  // simple, transparent, no hidden weighting scheme presented as objective truth.
  const percentileRank = (arr: AnnotatedPortfolio[], key: (p: AnnotatedPortfolio) => number, higherIsBetter: boolean) => {
    const sorted = [...arr].sort((a, b) => (higherIsBetter ? key(a) - key(b) : key(b) - key(a)));
    const rankMap = new Map<AnnotatedPortfolio, number>();
    sorted.forEach((p, i) => rankMap.set(p, i / Math.max(sorted.length - 1, 1)));
    return rankMap;
  };
  const earningRank = percentileRank(annotated, (p) => p.expectedProfit, true);
  const stabilityRank = percentileRank(annotated, (p) => p.cv, false);
  const waterRank = percentileRank(annotated, (p) => p.waterScore, false);
  const soilRankValue = (p: AnnotatedPortfolio) => (p.soilImpact === 'replenishing' ? 1 : p.soilImpact === 'neutral' ? 0.5 : 0);

  const balanced = [...annotated].sort((a, b) => {
    const scoreA = (earningRank.get(a)! + stabilityRank.get(a)! + waterRank.get(a)! + soilRankValue(a)) / 4;
    const scoreB = (earningRank.get(b)! + stabilityRank.get(b)! + waterRank.get(b)! + soilRankValue(b)) / 4;
    return scoreB - scoreA;
  })[0];

  const stabilityCaveat = (p: AnnotatedPortfolio) =>
    p.riskMeasurement === 'unmeasured'
      ? ' — NOTE: no real price-variability data for these crops, so this looks stable partly because risk is unmeasured, not proven low'
      : p.riskMeasurement === 'partial'
      ? ' — NOTE: risk data is incomplete for part of this mix, treat the stability read with some caution'
      : '';

  const picks: { tag: ShortlistTag; portfolio: AnnotatedPortfolio; headline: string }[] = [
    { tag: 'highest_earning', portfolio: byEarning[0], headline: 'Highest earning potential — accepts more year-to-year swing' + stabilityCaveat(byEarning[0]) },
    { tag: 'most_stable', portfolio: byStability[0], headline: 'Most stable income — smallest relative swing between a good and bad year' + stabilityCaveat(byStability[0]) },
    { tag: 'best_soil_health', portfolio: bySoil[0] ?? byEarning[0], headline: 'Best for your land long-term — replenishes soil rather than depleting it' },
    { tag: 'most_water_sustainable', portfolio: byWater[0], headline: 'Most water-sustainable — least reliant on heavy-water crops' },
    { tag: 'balanced', portfolio: balanced, headline: 'Balanced — reasonable on earning, stability, soil, and water together' + stabilityCaveat(balanced) },
  ];

  // Merge picks that landed on the identical combination so it's shown once with all its tags.
  const merged = new Map<string, ShortlistOption>();
  for (const pick of picks) {
    const key = pick.portfolio.cropNames.slice().sort().join('+') + '|' + JSON.stringify(pick.portfolio.weights);
    if (merged.has(key)) {
      merged.get(key)!.tags.push(pick.tag);
    } else {
      merged.set(key, { tags: [pick.tag], headline: pick.headline, portfolio: pick.portfolio });
    }
  }

  return Array.from(merged.values());
}
