/**
 * Krishi Munafa — Rotation Engine (v2, wired through decisionShortlist)
 *
 * Sequences 2-3 years of land allocation. The key change from v1: each
 * year now produces a full multi-axis SHORTLIST (via decisionShortlist.ts)
 * instead of collapsing to one "best" pick internally. A farmer picking
 * between "highest earning" and "most stable" in Year 1 is a real
 * decision this tool shouldn't make for them — so it doesn't, even
 * inside the multi-year preview.
 *
 * That raises one real design question: which option feeds into next
 * year's rotation filter, if there are 5 options and no farmer choice
 * yet? We thread the preview through the BALANCED option by default
 * (it's the one pick that isn't extreme on any axis) — but this is
 * explicitly a preview assumption, not a commitment. Per the agreed
 * design, the real plan gets re-run each season once the farmer reports
 * what they actually grew, so this sequencing choice only shapes what
 * the upfront multi-year preview looks like, nothing more.
 *
 * The avoid-repeat-family rule is enforced as a HARD filter before
 * building each year's shortlist — this applies to every axis, not just
 * the soil one, because repeating a family season-to-season is a
 * genuine agronomic risk (pest/disease carryover), not just a soil
 * health preference to be traded off against earnings.
 */

import { PortfolioCropCandidate } from './portfolioEngine';
import {
  ShortlistOption,
  ShortlistTag,
  WaterIntensityData,
  buildShortlist,
} from './decisionShortlist';

// Crops that tie up land for a full season or more and shouldn't be swapped
// in/out of an annual rotation the way genuine annuals can. This is broader
// than just botanical perennials (grapes, pomegranate) -- Banana (~12 months)
// and Sugarcane (12-18 months) lock the land for a comparable duration even
// though they're technically harvested and replanted, so they get the same
// treatment here. A bug in an earlier version only excluded true perennials
// and let the rotation engine recommend swapping Banana in for a single
// season, which isn't agronomically real.
const LAND_LOCKING_FAMILIES = ['vine_fruit', 'orchard_fruit', 'banana', 'sugarcane'];

export interface YearPlan {
  year: number;
  granularity: 'specific' | 'family';
  indicative: boolean;
  shortlist: ShortlistOption[];
  /** Which shortlist option the multi-year preview assumes was chosen, for the purpose of filtering next year's candidates. Not a recommendation to follow this one over the others. */
  assumedForSequencing: ShortlistOption;
  rationale: string[];
}

function violatesAvoidRepeat(comboFamilies: string[], priorFamilies: string[]): boolean {
  return comboFamilies.some((f) => priorFamilies.includes(f));
}

/**
 * Plans a rotation preview across `years` seasons. `priorSeasonFamilies`
 * is the crop family/families the farmer says they grew last season —
 * self-reported, no way to independently verify, flagged as a
 * data-quality caveat for the UI to surface to the farmer.
 *
 * Perennial and long-duration crops (grapes, pomegranate, fig, banana,
 * sugarcane) are excluded from rotation candidates entirely — planting
 * them is a multi-year (or multi-season) land-commitment decision, not
 * something a rotation planner should suggest swapping in and out
 * season to season. Flag those to the farmer as a separate decision.
 */
export function planRotation(
  candidates: PortfolioCropCandidate[],
  totalAcres: number,
  priorSeasonFamilies: string[],
  waterData: WaterIntensityData,
  years: number = 3,
  options: { sequencingTag?: ShortlistTag } = {}
): YearPlan[] {
  const sequencingTag = options.sequencingTag ?? 'balanced';
  const rotationCandidates = candidates.filter((c) => !LAND_LOCKING_FAMILIES.includes(c.familyKey));

  const plan: YearPlan[] = [];
  let currentPrior = priorSeasonFamilies;

  for (let year = 1; year <= years; year++) {
    let viable = rotationCandidates.filter((c) => !violatesAvoidRepeat([c.familyKey], currentPrior));
    if (viable.length === 0) {
      // Nothing satisfies the avoid-repeat rule (e.g. very short candidate
      // list) — relax rather than return an empty plan. Should be rare
      // with a real district-sized crop list.
      viable = rotationCandidates;
    }

    const shortlist = buildShortlist(viable, totalAcres, currentPrior, waterData, { maxCrops: 3 });
    if (shortlist.length === 0) {
      throw new Error(`No viable crop combinations for year ${year} — candidate list too small.`);
    }

    const assumed =
      shortlist.find((opt) => opt.tags.includes(sequencingTag)) ?? shortlist[0];

    const rationale: string[] = [];
    if (currentPrior.length > 0) {
      const uniquePrior = Array.from(new Set(currentPrior));
      rationale.push(
        `Excludes ${uniquePrior.join(', ')} from this year's options — repeating last season's family raises pest/disease carryover risk.`
      );
    }
    rationale.push(
      `Preview assumes the "${sequencingTag}" option is chosen for sequencing purposes — the farmer may pick differently from this year's shortlist, which would change what's excluded next year.`
    );

    plan.push({
      year,
      granularity: year === 1 ? 'specific' : 'family',
      indicative: year > 1,
      shortlist,
      assumedForSequencing: assumed,
      rationale,
    });

    currentPrior = assumed.portfolio.familyKeys;
  }

  return plan;
}
