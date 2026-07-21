/**
 * Krishi Munafa — Year Plan Engine (v2)
 *
 * v1 bug, caught directly: once a perennial crop (Grapes, Pomegranate,
 * etc.) locked land for future seasons, those future seasons showed
 * zero profit -- as if the vineyard just... stopped producing. That's
 * wrong. An established perennial keeps bearing fruit and earning every
 * year; "no new planting decision needed here" and "no income here" are
 * two completely different things, and v1 conflated them.
 *
 * Design now:
 *  - A perennial's annual profit is attributed to the YEAR as a whole,
 *    counted exactly once per year (not once per season slot -- Kharif/
 *    Rabi/Summer are not three separate harvests of the same vineyard).
 *  - "Ongoing" holdings (perennials established in a PRIOR year) earn
 *    every subsequent year automatically, with no new decision needed.
 *  - Whatever land isn't held by an ongoing perennial goes through the
 *    normal Kharif -> Rabi -> Summer decision sequence, same as before.
 *  - Known simplification, stated plainly: real orchards/vineyards take
 *    2-3 years to reach full bearing maturity, and our source data is a
 *    single cross-sectional annual survey that can't distinguish a
 *    young planting's economics from a mature one. This model assumes
 *    full modeled profit starts the same year a perennial is planted --
 *    likely optimistic for year 1, and not distinguishing "ramping up"
 *    from "fully mature" in later years. Flagged, not hidden.
 */

import { PortfolioCropCandidate, getPerAcreStats } from './portfolioEngine';
import { ShortlistOption, WaterIntensityData, buildShortlist } from './decisionShortlist';

export type Season = 'Kharif' | 'Rabi' | 'Summer';
const SEASON_ORDER: Season[] = ['Kharif', 'Rabi', 'Summer'];
const PERENNIAL_FAMILIES = ['vine_fruit', 'orchard_fruit', 'banana', 'sugarcane'];

interface PerennialHolding {
  cropName: string;
  familyKey: string;
  profitPerAcre: number;
  acres: number;
  establishedYear: number;
}

export interface SeasonDecision {
  season: Season;
  availableAcres: number;
  shortlist: ShortlistOption[];
  /** True if there was no land left to make a NEW decision on this season -- doesn't mean no income, just no fresh choice (see YearSummary.ongoingPerennialProfit for what's still growing). */
  noNewDecision: boolean;
}

export interface YearSummary {
  year: number;
  granularity: 'specific' | 'indicative';
  /** Profit from perennials established in an EARLIER year, continuing to bear -- counted once per year, not once per season. */
  ongoingPerennialProfit: number;
  ongoingPerennialCrops: string[];
  /** Profit from whatever fresh annual decisions were made this year across Kharif/Rabi/Summer. */
  newDecisionProfit: number;
  /** ongoingPerennialProfit + newDecisionProfit. */
  totalProfit: number;
  /** All distinct crops with a stake in this year -- ongoing perennials plus newly-chosen annuals. */
  cropsGrown: string[];
  seasonDecisions: SeasonDecision[];
}

function isPerennialFamily(familyKey: string): boolean {
  return PERENNIAL_FAMILIES.includes(familyKey);
}

export interface YearlyCardSeason {
  season: Season;
  /** True if this season's crops are just an already-established perennial continuing (from an earlier season), not a fresh decision on this land. */
  isOngoing: boolean;
  cropWeights: Record<string, number>; // crop name -> fraction of TOTAL farm acres (not just available acres), for clean whole-year display
}

export interface YearlyStrategyCard {
  tag: string;
  headline: string;
  totalYearProfit: number;
  seasons: YearlyCardSeason[];
}

const CARD_TAGS = ['highest_earning', 'best_soil_health', 'most_water_sustainable', 'balanced'] as const;

/**
 * One card per strategy, each followed CONSISTENTLY through Kharif ->
 * Rabi -> Summer, instead of always defaulting to rank #1 at every
 * season boundary regardless of what a farmer actually chose. This
 * replaces click-to-select UI complexity with pre-computed whole-year
 * stories: a farmer picks ONE card and sees their whole year at once.
 */
export function planYearlyStrategyCards(
  candidates: PortfolioCropCandidate[],
  totalAcres: number,
  initialPriorFamilies: string[],
  waterData: WaterIntensityData,
  maxCropsPerSeason: number = 3
): YearlyStrategyCard[] {
  return CARD_TAGS.map((tag) => {
    const holdings: PerennialHolding[] = [];
    let currentPriorFamilies = initialPriorFamilies;
    let totalYearProfit = 0;
    const seasons: YearlyCardSeason[] = [];
    let headline = '';

    for (const season of SEASON_ORDER) {
      const lockedAcres = holdings.reduce((s, h) => s + h.acres, 0);
      const remainingAcres = Math.max(totalAcres - lockedAcres, 0);

      if (remainingAcres <= 0.01) {
        const cropWeights: Record<string, number> = {};
        holdings.forEach((h) => (cropWeights[h.cropName] = (cropWeights[h.cropName] ?? 0) + h.acres / totalAcres));
        seasons.push({ season, isOngoing: true, cropWeights });
        continue;
      }

      const seasonCandidates = candidates.filter(
        (c) => !c.seasons || c.seasons.includes(season) || c.seasons.includes('Perennial')
      );
      const shortlist = buildShortlist(seasonCandidates, remainingAcres, currentPriorFamilies, waterData, {
        maxCrops: maxCropsPerSeason,
      });
      // Fall back to 'balanced', then rank 1, if this specific tag isn't
      // present this season (can happen after the profitability floor
      // and option-merging collapse the shortlist to fewer than 5 slots).
      const pick =
        shortlist.find((o) => o.tags.includes(tag as any)) ??
        shortlist.find((o) => o.tags.includes('balanced')) ??
        shortlist[0];

      if (!pick) {
        seasons.push({ season, isOngoing: false, cropWeights: {} });
        continue;
      }
      if (season === 'Kharif') headline = pick.headline;

      totalYearProfit += pick.portfolio.expectedProfit;
      currentPriorFamilies = pick.portfolio.familyKeys;

      const cropWeights: Record<string, number> = {};
      holdings.forEach((h) => (cropWeights[h.cropName] = (cropWeights[h.cropName] ?? 0) + h.acres / totalAcres));
      pick.portfolio.cropNames.forEach((name) => {
        const w = pick.portfolio.weights[name] ?? 0;
        cropWeights[name] = (cropWeights[name] ?? 0) + (w * remainingAcres) / totalAcres;
      });
      seasons.push({ season, isOngoing: false, cropWeights });

      const seasonStartingAcres = remainingAcres;
      let acresClaimedByPerennials = 0;
      pick.portfolio.familyKeys.forEach((familyKey, i) => {
        if (isPerennialFamily(familyKey)) {
          const cropName = pick.portfolio.cropNames[i];
          const weight = pick.portfolio.weights[cropName] ?? 0;
          const acresForCrop = weight * seasonStartingAcres;
          const candidate = candidates.find((c) => c.cropName === cropName);
          if (candidate) {
            const stats = getPerAcreStats(candidate);
            holdings.push({ cropName, familyKey, profitPerAcre: stats.meanProfitPerAcre, acres: acresForCrop, establishedYear: 1 });
            acresClaimedByPerennials += acresForCrop;
          }
        }
      });
      // Ongoing perennial income within THIS SAME year is already counted
      // via pick.portfolio.expectedProfit above (it's part of that
      // season's fresh decision) -- holdings only start contributing
      // separately from Year 2 onward via planMultiYearSummary, not here.
    }

    return { tag, headline, totalYearProfit, seasons };
  });
}


/**
 * Plans N years with continuous state -- an ongoing perennial's income
 * and land-lock carry forward every year until this preview ends; we
 * have no data suggesting a fixed perennial lifespan, so it's treated
 * as ongoing rather than arbitrarily expiring after one year.
 */
export function planMultiYearSummary(
  candidates: PortfolioCropCandidate[],
  totalAcres: number,
  initialPriorFamilies: string[],
  waterData: WaterIntensityData,
  numYears: number,
  maxCropsPerSeason: number = 3
): YearSummary[] {
  const holdings: PerennialHolding[] = [];
  let currentPriorFamilies = initialPriorFamilies;
  const years: YearSummary[] = [];

  for (let year = 1; year <= numYears; year++) {
    const ongoingHoldings = holdings.filter((h) => h.establishedYear < year);
    const ongoingPerennialProfit = ongoingHoldings.reduce((sum, h) => sum + h.profitPerAcre * h.acres, 0);
    const ongoingPerennialCrops = Array.from(new Set(ongoingHoldings.map((h) => h.cropName)));
    const lockedAcres = holdings.reduce((sum, h) => sum + h.acres, 0);

    let remainingAcres = Math.max(totalAcres - lockedAcres, 0);
    let newDecisionProfit = 0;
    const newCropsThisYear = new Set<string>();
    const seasonDecisions: SeasonDecision[] = [];

    for (const season of SEASON_ORDER) {
      if (remainingAcres <= 0.01) {
        seasonDecisions.push({ season, availableAcres: 0, shortlist: [], noNewDecision: true });
        continue;
      }

      const seasonCandidates = candidates.filter(
        (c) => !c.seasons || c.seasons.includes(season) || c.seasons.includes('Perennial')
      );
      const shortlist = buildShortlist(seasonCandidates, remainingAcres, currentPriorFamilies, waterData, {
        maxCrops: maxCropsPerSeason,
      });
      seasonDecisions.push({ season, availableAcres: remainingAcres, shortlist, noNewDecision: false });

      const pick = shortlist.find((o) => o.rank === 1);
      if (!pick) continue;

      newDecisionProfit += pick.portfolio.expectedProfit;
      pick.portfolio.cropNames.forEach((name) => newCropsThisYear.add(name));
      currentPriorFamilies = pick.portfolio.familyKeys;

      // BUG (found via unit test, not assumed fixed): weights are
      // fractions of the season's STARTING acreage and should all be
      // computed against that fixed value. The old code mutated
      // remainingAcres inside this same loop, so a second perennial in
      // the same pick got its acreage computed against an
      // already-shrunk remainder instead of the original -- e.g.
      // Pomegranate 51% + Grapes 49% of 3.00 acres should lock all 3.00,
      // but sequential mutation left 0.75 acres "unclaimed" that leaked
      // into the next season instead of being properly locked here.
      const seasonStartingAcres = remainingAcres;
      let acresClaimedByPerennials = 0;
      pick.portfolio.familyKeys.forEach((familyKey, i) => {
        if (isPerennialFamily(familyKey)) {
          const cropName = pick.portfolio.cropNames[i];
          const weight = pick.portfolio.weights[cropName] ?? 0;
          const acresForCrop = weight * seasonStartingAcres;
          const candidate = candidates.find((c) => c.cropName === cropName);
          if (candidate) {
            const stats = getPerAcreStats(candidate);
            holdings.push({
              cropName,
              familyKey,
              profitPerAcre: stats.meanProfitPerAcre,
              acres: acresForCrop,
              establishedYear: year,
            });
            acresClaimedByPerennials += acresForCrop;
          }
        }
      });
      remainingAcres -= acresClaimedByPerennials;
    }

    const cropsGrown = Array.from(new Set([...ongoingPerennialCrops, ...newCropsThisYear]));

    years.push({
      year,
      granularity: year === 1 ? 'specific' : 'indicative',
      ongoingPerennialProfit,
      ongoingPerennialCrops,
      newDecisionProfit,
      totalProfit: ongoingPerennialProfit + newDecisionProfit,
      cropsGrown,
      seasonDecisions,
    });
  }

  return years;
}
