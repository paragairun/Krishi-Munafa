/**
 * Krishi Munafa — Farmer Memory
 *
 * This is what closes the loop from the "is the job over after one
 * recommendation?" discussion: without this, every visit starts from
 * zero, the rotation engine's avoid-repeat logic has nothing real to
 * check against, and the tool can never get more accurate than its
 * initial sourced data.
 *
 * Three things this module does:
 *  1. Find or create a farmer record (phone number as ID)
 *  2. Log every recommendation run, and every self-reported actual
 *     planting, so next season's "what did you grow last season" isn't
 *     a dropdown -- it's a real lookup
 *  3. Optionally record outcomes, for improving data accuracy over time
 *
 * All writes are best-effort: a farmer using the tool anonymously (no
 * phone number given) should still get a full recommendation --
 * memory is additive, not a gate.
 */

import { supabase } from './supabaseClient';
import type { ShortlistOption } from './decisionShortlist';

export interface Farmer {
  id: string;
  phoneNumber: string;
  districtId: string | null;
  landAcres: number | null;
  defaultIrrigation: string | null;
  preferredLanguage: string;
}

/**
 * Finds a farmer by phone number, or creates one if this is their first
 * visit. Phone number is the natural identifier for this audience --
 * see schema.sql comment for why (no email/username assumption).
 */
export async function findOrCreateFarmer(
  phoneNumber: string,
  defaults?: { districtId?: string; landAcres?: number; defaultIrrigation?: string }
): Promise<Farmer | null> {
  const { data: existing, error: findError } = await supabase
    .from('farmers')
    .select('*')
    .eq('phone_number', phoneNumber)
    .maybeSingle();

  if (findError) {
    console.error('findOrCreateFarmer: lookup failed', findError);
    return null;
  }
  if (existing) return mapFarmer(existing);

  const { data: created, error: createError } = await supabase
    .from('farmers')
    .insert({
      phone_number: phoneNumber,
      district_id: defaults?.districtId ?? null,
      land_acres: defaults?.landAcres ?? null,
      default_irrigation: defaults?.defaultIrrigation ?? null,
    })
    .select()
    .single();

  if (createError) {
    console.error('findOrCreateFarmer: create failed', createError);
    return null;
  }
  return mapFarmer(created);
}

/**
 * Retrieves what this farmer says they actually planted most recently --
 * this is the real replacement for the "grew last season" dropdown.
 * Returns the crop family list from their latest actual_plantings row,
 * or null if we have no record (new farmer, or they've never reported).
 * Callers should fall back to asking the farmer directly when this is null.
 */
export async function getLastReportedPlanting(farmerId: string): Promise<string[] | null> {
  const { data, error } = await supabase
    .from('actual_plantings')
    .select('crops_planted, reported_at')
    .eq('farmer_id', farmerId)
    .order('reported_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('getLastReportedPlanting: lookup failed', error);
    return null;
  }
  return data?.crops_planted ?? null;
}

/**
 * Logs a recommendation run. Call this every time buildShortlist()
 * produces a result for an identified farmer -- this is the audit trail
 * that lets us later ask "did they follow our pick, and how did it go."
 */
export async function saveRecommendation(
  farmerId: string,
  seasonLabel: string,
  shortlist: ShortlistOption[]
): Promise<string | null> {
  const ourPick = shortlist.find((o) => o.rank === 1);
  const { data, error } = await supabase
    .from('recommendations')
    .insert({
      farmer_id: farmerId,
      season_label: seasonLabel,
      shortlist: shortlist,
      our_pick_crops: ourPick?.portfolio.cropNames ?? [],
    })
    .select('id')
    .single();

  if (error) {
    console.error('saveRecommendation: insert failed', error);
    return null;
  }
  return data.id;
}

/**
 * Records what the farmer says they actually planted -- self-reported,
 * no independent verification possible. This should be surfaced to the
 * farmer-facing UI as a simple, low-friction check-in (e.g. "did you
 * plant what we suggested?" with a yes/change-it flow), not a form.
 */
export async function saveActualPlanting(
  farmerId: string,
  seasonLabel: string,
  cropsPlanted: string[],
  recommendationId?: string,
  followedRecommendation?: boolean
): Promise<string | null> {
  const { data, error } = await supabase
    .from('actual_plantings')
    .insert({
      farmer_id: farmerId,
      season_label: seasonLabel,
      recommendation_id: recommendationId ?? null,
      crops_planted: cropsPlanted,
      followed_recommendation: followedRecommendation ?? null,
    })
    .select('id')
    .single();

  if (error) {
    console.error('saveActualPlanting: insert failed', error);
    return null;
  }
  return data.id;
}

/**
 * Records an optional outcome report -- entirely voluntary, most farmers
 * won't fill this in, and that's fine. This is the one piece of data in
 * the whole system that can eventually beat the sourced-but-aging
 * baseline data, since it's a real observed result rather than an
 * escalated 2018-19 estimate.
 */
export async function saveReportedOutcome(
  farmerId: string,
  actualPlantingId: string,
  outcome: {
    cropName: string;
    actualYieldQtlPerAcre?: number;
    actualSalePricePerQtl?: number;
    channelUsed?: string;
    notes?: string;
  }
): Promise<boolean> {
  const { error } = await supabase.from('reported_outcomes').insert({
    farmer_id: farmerId,
    actual_planting_id: actualPlantingId,
    crop_name: outcome.cropName,
    actual_yield_qtl_per_acre: outcome.actualYieldQtlPerAcre ?? null,
    actual_sale_price_per_qtl: outcome.actualSalePricePerQtl ?? null,
    channel_used: outcome.channelUsed ?? null,
    notes: outcome.notes ?? null,
  });

  if (error) {
    console.error('saveReportedOutcome: insert failed', error);
    return false;
  }
  return true;
}

function mapFarmer(row: any): Farmer {
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    districtId: row.district_id,
    landAcres: row.land_acres,
    defaultIrrigation: row.default_irrigation,
    preferredLanguage: row.preferred_language,
  };
}
