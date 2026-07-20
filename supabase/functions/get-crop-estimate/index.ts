// Krishi Munafa — get-crop-estimate Edge Function
// Deploy: supabase functions deploy get-crop-estimate
// Secret required: AGMARKNET_API_KEY (register free at https://data.gov.in)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const AGMARKNET_RESOURCE_ID = '9ef84268-d588-465a-a308-a864a43d0070'; // data.gov.in: variety-wise daily mandi prices — VERIFY this resource id is still current before relying on it
const AGMARKNET_BASE_URL = 'https://api.data.gov.in/resource';

interface RequestBody {
  cropId: string;
  districtId: string;
  agmarknetCommodity: string;
  agmarknetVariety?: string;
  stateName: string;
  districtName: string;
}

Deno.serve(async (req) => {
  try {
    const body: RequestBody = await req.json();
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // 1. Try live Agmarknet data first
    const live = await fetchLiveMandiPrice(body);
    if (live) {
      // cache it for next time / offline resilience
      await supabase.from('mandi_price_cache').upsert({
        crop_id: body.cropId,
        district_id: body.districtId,
        market_name: live.market,
        price_min_per_qtl: live.min,
        price_max_per_qtl: live.max,
        price_modal_per_qtl: live.modal,
        arrival_date: live.arrivalDate,
      });
      return jsonResponse({ source: 'live', ...live });
    }

    // 2. Fall back to cached recent live data (e.g. last 7 days) if fresh enough
    const { data: cached } = await supabase
      .from('mandi_price_cache')
      .select('*')
      .eq('crop_id', body.cropId)
      .eq('district_id', body.districtId)
      .order('arrival_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cached && isRecent(cached.arrival_date, 7)) {
      return jsonResponse({
        source: 'cache',
        min: cached.price_min_per_qtl,
        max: cached.price_max_per_qtl,
        modal: cached.price_modal_per_qtl,
        arrivalDate: cached.arrival_date,
      });
    }

    // 3. Fall back to static verified/unverified baseline table
    const { data: baseline } = await supabase
      .from('crop_baseline')
      .select('*')
      .eq('crop_id', body.cropId)
      .eq('district_id', body.districtId)
      .maybeSingle();

    if (baseline) {
      return jsonResponse({ source: 'baseline', baseline });
    }

    return jsonResponse(
      { error: 'No live, cached, or baseline data found for this crop/district combination' },
      404
    );
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});

async function fetchLiveMandiPrice(body: RequestBody) {
  const apiKey = Deno.env.get('AGMARKNET_API_KEY');
  if (!apiKey) return null;

  const params = new URLSearchParams({
    'api-key': apiKey,
    format: 'json',
    limit: '10',
    'filters[state]': body.stateName,
    'filters[district]': body.districtName,
    'filters[commodity]': body.agmarknetCommodity,
  });
  if (body.agmarknetVariety) {
    params.set('filters[variety]', body.agmarknetVariety);
  }

  const url = `${AGMARKNET_BASE_URL}/${AGMARKNET_RESOURCE_ID}?${params.toString()}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const records = data?.records;
    if (!records || records.length === 0) return null;

    // Take the most recent record
    const latest = records[0];
    return {
      market: latest.market,
      min: Number(latest.min_price),
      max: Number(latest.max_price),
      modal: Number(latest.modal_price),
      arrivalDate: latest.arrival_date,
    };
  } catch {
    // network issue, bad response shape, etc — treat as "no live data", fall through
    return null;
  }
}

function isRecent(dateStr: string, maxDays: number) {
  const date = new Date(dateStr);
  const diffDays = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays <= maxDays;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
