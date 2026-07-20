/**
 * Krishi Munafa — Year Plan Engine
 *
 * Recommending one season in isolation confuses a farmer who's actually
 * planning a whole year of land use. This module produces a connected
 * Kharif -> Rabi -> Summer plan for a single calendar year (the
 * multi-year rotation preview in rotationEngine.ts then chains multiple
 * of these together for a 2-3 year view).
 *
 * Two rules specific to this module, beyond the ordinary single-season
 * shortlist:
 *  1. Rotation (avoid-repeat-family) applies BETWEEN SEASONS within the
 *     year too, not just year to year -- Kharif's choice constrains
 *     what's sensible for Rabi on the same land.
 *  2. If "our pick" for an earlier season includes a perennial crop
 *     (Grapes, Pomegranate, etc.), that portion of land is occupied for
 *     every season after it THIS YEAR (and, realistically, for years
 *     beyond) -- per explicit product decision, this is shown as
 *     "this much land is unavailable because of the perennial," not
 *     re-offered as if it were free to replant.
 */

import { PortfolioCropCandidate } from './portfolioEngine';
import { ShortlistOption, WaterIntensityData, buildShortlist } from './decisionShortlist';

export type Season = 'Kharif' | 'Rabi' | 'Summer';

const SEASON_ORDER: Season[] = ['Kharif', 'Rabi', 'Summer'];
const PERENNIAL_FAMILIES = ['vine_fruit', 'orchard_fruit', 'banana', 'sugarcane'];

export interface SeasonPlan {
  season: Season;
  /** Acres actually available this season -- less than totalAcres if a perennial from an earlier season this year is occupying part of the land. */
  availableAcres: number;
  /** Acres locked by a perennial planted in an earlier season this year -- 0 if none. */
  acresLockedByPerennial: number;
  shortlist: ShortlistOption[];
  /** True if availableAcres is 0 -- nothing to recommend, land fully occupied by a perennial. */
  noLandAvailable: boolean;
}

export interface YearPlan {
  totalAcres: number;
  seasons: SeasonPlan[];
}

function isPerennialPick(option: ShortlistOption): boolean {
  return option.portfolio.familyKeys.some((f) => PERENNIAL_FAMILIES.includes(f));
}

/**
 * Estimates what fraction of land a chosen option's perennial crop(s)
 * occupy, so the remaining seasons this year know how much land is left.
 * Non-perennial crops in the same combo don't lock land season-to-season,
 * only the perennial portion does.
 */
function perennialAcresFraction(option: ShortlistOption): number {
  let fraction = 0;
  option.portfolio.familyKeys.forEach((familyKey, i) => {
    if (PERENNIAL_FAMILIES.includes(familyKey)) {
      const cropName = option.portfolio.cropNames[i];
      fraction += option.portfolio.weights[cropName] ?? 0;
    }
  });
  return fraction;
}

/**
 * Builds a full-year plan: Kharif, Rabi, and Summer in sequence, each
 * filtered to crops actually grown in that season, with rotation
 * carried between seasons and perennial land-locking applied.
 *
 * `priorSeasonFamilies` is what the farmer says they grew in the season
 * immediately before this year's Kharif (i.e. last year's Summer or
 * Rabi) -- self-reported, same caveat as everywhere else in this app.
 */
export function planYear(
  candidates: PortfolioCropCandidate[],
  totalAcres: number,
  priorSeasonFamilies: string[],
  waterData: WaterIntensityData,
  options: { seasons?: Season[]; maxCrops?: number } = {}
): YearPlan {
  const seasonsToInclude = options.seasons ?? SEASON_ORDER;
  const seasonPlans: SeasonPlan[] = [];

  let currentPriorFamilies = priorSeasonFamilies;
  let acresLockedByPerennial = 0;

  for (const season of seasonsToInclude) {
    const availableAcres = Math.max(totalAcres - acresLockedByPerennial * totalAcres, 0);
    const noLandAvailable = availableAcres <= 0.01;

    if (noLandAvailable) {
      seasonPlans.push({
        season,
        availableAcres: 0,
        acresLockedByPerennial: totalAcres,
        shortlist: [],
        noLandAvailable: true,
      });
      continue;
    }

    const seasonCandidates = candidates.filter(
      (c) => c.seasons?.includes(season) ?? true // no season tag = assume available (backward compat)
    );

    const shortlist = buildShortlist(
      seasonCandidates,
      availableAcres,
      currentPriorFamilies,
      waterData,
      { maxCrops: options.maxCrops ?? 3 }
    );

    seasonPlans.push({
      season,
      availableAcres,
      acresLockedByPerennial: totalAcres - availableAcres,
      shortlist,
      noLandAvailable: false,
    });

    // Thread rotation + perennial-locking forward using this season's #1 pick.
    const ourPick = shortlist.find((o) => o.rank === 1);
    if (ourPick) {
      currentPriorFamilies = ourPick.portfolio.familyKeys;
      if (isPerennialPick(ourPick)) {
        acresLockedByPerennial += perennialAcresFraction(ourPick);
      }
    }
  }

  return { totalAcres, seasons: seasonPlans };
}
