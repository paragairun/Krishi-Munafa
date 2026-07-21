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

// Default CV-tie threshold, used only if the caller doesn't pass one
// explicitly to buildShortlist(). Real-world price/yield estimates
// (especially the assumed bands for unmeasured crops) aren't precise
// enough that a small CV gap should ever decide a recommendation on its
// own -- but this is a parameter, not a law, so it's passed through
// rather than baked into the ranking logic itself. See groupByTolerance.
const DEFAULT_CV_SIGNIFICANCE_THRESHOLD = 0.1;

// Minimum viability floor: no axis (stability, soil, water) should ever be
// allowed to recommend an option that earns less than this fraction of the
// best available profit. Without this, an axis optimizing purely for its
// own metric (e.g. water-sustainability gravitating to a low-value legume
// monocrop) can produce a technically-correct "winner" that isn't actually
// a livable choice -- exactly what happened before this was added: a 100%
// Gram monocrop with the highest CV on the whole shortlist got crowned
// "most water sustainable" purely because it used the least water. 0.5
// chosen deliberately: wide enough to keep real tradeoffs visible (a
// farmer who genuinely prioritizes water use over income should still see
// a meaningfully different option), strict enough to rule out
// poverty-level picks masquerading as a legitimate axis winner.
const MIN_VIABILITY_FRACTION = 0.5;

/**
 * Groups items by actual gap between neighboring values, not a fixed
 * rounding grid. This matters: rounding 0.41 and 0.50 to the nearest 0.1
 * puts them in different buckets (0.4 vs 0.5) even though the real gap
 * (0.09) is under the threshold -- an arbitrary grid-line artifact, not
 * a real difference. Here, values are sorted and walked in order; a new
 * group starts only when the gap to the PREVIOUS value is >= threshold.
 * So 0.41 and 0.50 (gap 0.09) tie; 0.41 and 0.51 (gap 0.10) do not --
 * matching "0.1 or more counts as a real difference" exactly, with no
 * grid-boundary artifacts. Returns a 0-1 percentile score per item,
 * tied items sharing the same score.
 */
function groupByTolerance<T>(
  items: T[],
  keyFn: (item: T) => number,
  threshold: number,
  lowerIsBetter: boolean
): Map<T, number> {
  const sorted = [...items].sort((a, b) => keyFn(a) - keyFn(b));
  const groupIndex: number[] = [0];
  for (let i = 1; i < sorted.length; i++) {
    const gap = keyFn(sorted[i]) - keyFn(sorted[i - 1]);
    groupIndex.push(gap >= threshold ? groupIndex[i - 1] + 1 : groupIndex[i - 1]);
  }
  const maxGroup = groupIndex[groupIndex.length - 1] || 1;
  const scoreMap = new Map<T, number>();
  sorted.forEach((item, i) => {
    const normalized = groupIndex[i] / Math.max(maxGroup, 1);
    scoreMap.set(item, lowerIsBetter ? 1 - normalized : normalized);
  });
  return scoreMap;
}

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
  | 'best_soil_health'
  | 'most_water_sustainable'
  | 'balanced';

export interface ShortlistOption {
  tags: ShortlistTag[];
  headline: string;
  portfolio: AnnotatedPortfolio;
  /** 1-based position in the ordered list, 1 = our pick. Computed from the same composite score used to choose "balanced" -- ordering is derived, not hand-picked, so it stays reproducible and explainable. */
  rank: number;
  /** Short, plain-language reason for this rank, meant to be spoon-fed to a farmer who shouldn't have to compare 4 cards unassisted. */
  recommendationNote: string;
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
  options: { maxCrops?: number; cvSignificanceThreshold?: number } = {}
): ShortlistOption[] {
  const all = evaluateAllCombinations(candidates, totalAcres, { maxCrops: options.maxCrops ?? 3 });
  if (all.length === 0) return [];

  const annotated = all.map((p) => annotate(p, priorFamilies, waterData));

  const byEarning = [...annotated].sort((a, b) => b.expectedProfit - a.expectedProfit);

  // Profitability floor: stability/soil/water/balanced only get to pick
  // from combinations earning at least MIN_VIABILITY_FRACTION of the best
  // available profit. "Highest earning" itself is exempt on purpose --
  // it's the reference point the floor is measured against, and its
  // headline already warns it "accepts more year-to-year swing," so
  // showing the true best-case number there isn't misleading the way an
  // unguarded "most stable" or "most water sustainable" pick would be.
  const maxProfit = byEarning[0].expectedProfit;
  const viabilityFloor = maxProfit * MIN_VIABILITY_FRACTION;
  const viablePool = annotated.filter((p) => p.expectedProfit >= viabilityFloor);
  // Should never be empty (the max-profit combo always clears its own
  // floor), but guard anyway rather than let downstream code crash on an
  // empty array in some edge case we haven't hit yet.
  const pool = viablePool.length > 0 ? viablePool : annotated;

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
  const bySoil = [...pool]
    .filter((p) => p.soilImpact !== 'depleting')
    .sort((a, b) => {
      const rank = { replenishing: 0, neutral: 1, depleting: 2 };
      return rank[a.soilImpact] - rank[b.soilImpact] || b.expectedProfit - a.expectedProfit;
    });
  const byWater = [...pool].sort((a, b) => a.waterScore - b.waterScore || b.expectedProfit - a.expectedProfit);

  // Balanced: normalize each axis to a 0-1 percentile rank and average them —
  // simple, transparent, no hidden weighting scheme presented as objective truth.
  // Ranked within the viable pool too, for the same reason. All four axes
  // now use groupByTolerance (see its docstring) rather than naive
  // percentile rank -- earning and water were fixed here after tracing a
  // real case where a combo earning 55% of the top pick's profit got
  // crushed to a low rank purely because several others sat slightly
  // above it, not because it was actually a weak earner.

  // CV significance threshold: passed as a real parameter (default below),
  // never baked into the ranking logic. Used via groupByTolerance, which
  // compares actual gaps between neighboring values -- not a rounding
  // grid, which would wrongly split close values like 0.41/0.50 (gap
  // 0.09, under threshold) just because they round to different buckets.
  const cvSignificanceThreshold = options.cvSignificanceThreshold ?? DEFAULT_CV_SIGNIFICANCE_THRESHOLD;

  // Same fix as stability, applied consistently: naive percentile rank
  // stretches ANY difference into a full rank swing regardless of size,
  // so a combo earning 98% of the top pick's profit could still get
  // crushed toward the bottom of a crowded pool. Using tolerance-based
  // grouping here too -- earning within ~10% of a neighbor counts as a
  // tie, matching the same principle already applied to CV.
  const earningTolerance = pool.length > 0 ? Math.max(...pool.map((p) => p.expectedProfit)) * 0.1 : 0;
  const waterTolerance = 0.3; // water score is on a small 1-4 scale, so an absolute (not %) tolerance fits better

  const earningRank = groupByTolerance(pool, (p) => p.expectedProfit, earningTolerance, false);
  const stabilityRank = groupByTolerance(pool, (p) => p.cv, cvSignificanceThreshold, true);
  const waterRank = groupByTolerance(pool, (p) => p.waterScore, waterTolerance, true);
  const soilRankValue = (p: AnnotatedPortfolio) => (p.soilImpact === 'replenishing' ? 1 : p.soilImpact === 'neutral' ? 0.5 : 0);

  const balanced = [...pool].sort((a, b) => {
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
    { tag: 'best_soil_health', portfolio: bySoil[0] ?? byEarning[0], headline: 'Best for your land long-term — replenishes soil rather than depleting it' },
    { tag: 'most_water_sustainable', portfolio: byWater[0], headline: 'Most water-sustainable — least reliant on heavy-water crops' },
    { tag: 'balanced', portfolio: balanced, headline: 'Balanced — reasonable on earning, stability, soil, and water together' + stabilityCaveat(balanced) },
  ];

  // Merge picks that landed on the identical combination so it's shown once with all its tags.
  const merged = new Map<string, { tags: ShortlistTag[]; headline: string; portfolio: AnnotatedPortfolio }>();
  for (const pick of picks) {
    const key = pick.portfolio.cropNames.slice().sort().join('+') + '|' + JSON.stringify(pick.portfolio.weights);
    if (merged.has(key)) {
      merged.get(key)!.tags.push(pick.tag);
    } else {
      merged.set(key, { tags: [pick.tag], headline: pick.headline, portfolio: pick.portfolio });
    }
  }

  // Order the merged options by the same composite score used to choose
  // "balanced" -- this is what makes ranking possible without secretly
  // picking a winner: the score is the same transparent average-of-axes
  // already computed above, just applied to sort instead of to select one.
  // #1 becomes "our pick." Farmers shouldn't have to compare 4 unranked
  // cards unassisted -- but every rank still says WHY, in plain language,
  // rather than presenting an unexplained verdict.
  const compositeScore = (p: AnnotatedPortfolio) =>
    (earningRank.get(p)! + stabilityRank.get(p)! + waterRank.get(p)! + soilRankValue(p)) / 4;

  const ordered = Array.from(merged.values()).sort(
    (a, b) => compositeScore(b.portfolio) - compositeScore(a.portfolio)
  );

  const recommendationNote = (tags: ShortlistTag[], rank: number): string => {
    if (rank === 1) {
      return 'Our pick — the best all-round balance of earning, stability, soil health, and water use, out of everything we checked.';
    }
    if (tags.includes('highest_earning')) {
      return 'Earns more than our pick, but the amount swings more between a good year and a bad year.';
    }
    if (tags.includes('best_soil_health')) {
      return 'Best choice if keeping your land healthy for future seasons matters most to you.';
    }
    if (tags.includes('most_water_sustainable')) {
      return 'Best choice if water is tight or unreliable for you right now.';
    }
    return 'Another reasonable option, worth a look if our pick doesn\'t fit your situation.';
  };

  return ordered.map((o, i) => ({
    ...o,
    rank: i + 1,
    recommendationNote: recommendationNote(o.tags, i + 1),
  }));
}
