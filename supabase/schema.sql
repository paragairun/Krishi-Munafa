-- Krishi Munafa schema
-- Run in Supabase SQL Editor. Safe to re-run (IF NOT EXISTS guards).

create table if not exists states (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
);

create table if not exists districts (
  id uuid primary key default gen_random_uuid(),
  state_id uuid references states(id) not null,
  name text not null,
  -- climate_risk_index: 0 (very stable/irrigated) to 1 (highly drought/flood prone)
  -- placeholder until sourced from IMD / state agri dept drought classification
  climate_risk_index numeric default 0.3,
  unique(state_id, name)
);

create table if not exists crops (
  id uuid primary key default gen_random_uuid(),
  crop_type text not null,        -- e.g. 'Grains'
  crop_name text not null,        -- e.g. 'Wheat'
  variety text,                   -- e.g. 'Lokwan Gujrat'
  -- agmarknet commodity/variety names, for API matching
  agmarknet_commodity text,
  agmarknet_variety text,
  unique(crop_type, crop_name, variety)
);

-- Static/verified baseline data — the fallback layer when live API has no recent record
create table if not exists crop_baseline (
  id uuid primary key default gen_random_uuid(),
  crop_id uuid references crops(id) not null,
  district_id uuid references districts(id) not null,
  yield_min_qtl_per_acre numeric not null,
  yield_max_qtl_per_acre numeric not null,
  price_min_per_qtl numeric not null,
  price_max_per_qtl numeric not null,
  cost_seed_per_acre numeric not null default 0,
  cost_fertilizer_per_acre numeric not null default 0,
  cost_pesticide_per_acre numeric not null default 0,
  cost_labour_per_acre numeric not null default 0,
  cost_irrigation_per_acre numeric not null default 0,
  cost_other_per_acre numeric not null default 0,
  source text not null,           -- e.g. 'Maharashtra Cost of Cultivation Report 2024-25'
  source_url text,
  verified boolean not null default false,
  last_reviewed date,
  unique(crop_id, district_id)
);

-- Cache of live Agmarknet API responses, refreshed daily by a scheduled Edge Function
create table if not exists mandi_price_cache (
  id uuid primary key default gen_random_uuid(),
  crop_id uuid references crops(id) not null,
  district_id uuid references districts(id) not null,
  market_name text,
  price_min_per_qtl numeric,
  price_max_per_qtl numeric,
  price_modal_per_qtl numeric,
  arrival_date date,
  fetched_at timestamptz not null default now(),
  unique(crop_id, district_id, market_name, arrival_date)
);

-- Multipliers for farming methodology — applied on top of baseline cost & yield
-- e.g. organic: -15% cost, -10% yield, +20% price premium (illustrative, needs verification)
create table if not exists methodology_multipliers (
  id uuid primary key default gen_random_uuid(),
  methodology text not null unique,   -- 'conventional' | 'organic' | 'natural_farming' | 'integrated'
  cost_multiplier numeric not null default 1.0,
  yield_multiplier numeric not null default 1.0,
  price_multiplier numeric not null default 1.0,
  notes text
);

insert into methodology_multipliers (methodology, cost_multiplier, yield_multiplier, price_multiplier, notes)
values
  ('conventional', 1.00, 1.00, 1.00, 'Baseline — no adjustment'),
  ('organic', 0.85, 0.88, 1.15, 'Lower input cost, typically lower yield in transition years, premium price IF certified/market access exists — needs verification per crop'),
  ('natural_farming', 0.70, 0.80, 1.05, 'Very low input cost (ZBNF-style), yield hit is significant esp. first 2-3 years — needs verification'),
  ('integrated', 0.95, 0.98, 1.00, 'IPM/balanced approach, minor cost saving vs conventional')
on conflict (methodology) do nothing;

-- Irrigation type affects yield reliability
create table if not exists irrigation_multipliers (
  id uuid primary key default gen_random_uuid(),
  irrigation_type text not null unique, -- 'rainfed' | 'canal' | 'borewell' | 'drip' | 'sprinkler'
  yield_multiplier numeric not null default 1.0,
  cost_per_acre numeric not null default 0,
  notes text
);

insert into irrigation_multipliers (irrigation_type, yield_multiplier, cost_per_acre, notes)
values
  ('rainfed', 0.80, 0, 'Fully dependent on monsoon — highest variance'),
  ('canal', 1.00, 1500, 'Baseline'),
  ('borewell', 1.05, 4000, 'Reliable but higher running cost (diesel/electricity)'),
  ('drip', 1.15, 8000, 'Highest efficiency, higher upfront cost — amortized here as annual'),
  ('sprinkler', 1.10, 6000, 'Good efficiency, moderate cost')
on conflict (irrigation_type) do nothing;

-- ============================================================
-- Selling channels — added after Pune scoping discussion.
-- No live pricing API exists for non-mandi channels (private commercial
-- data), so these are qualitative: is this channel realistically
-- accessible for this crop in this district, and roughly how does its
-- price realization compare to mandi where documented.
-- ============================================================

create table if not exists selling_channels (
  id uuid primary key default gen_random_uuid(),
  channel_key text not null unique,   -- 'mandi' | 'b2b_aggregator' | 'quick_commerce' | 'contract_farming' | 'fpo_collective'
  display_name text not null,
  description text not null
);

insert into selling_channels (channel_key, display_name, description) values
  ('mandi', 'APMC Mandi', 'Open wholesale auction — live pricing via Agmarknet, ~6-10% commission, no quality bar or price floor'),
  ('b2b_aggregator', 'B2B Agri-Aggregator', 'e.g. DeHaat, Ninjacart, WayCool — aggregates for retail/food-service, wants volume + grading, price not public'),
  ('quick_commerce', 'Quick-Commerce / Organized Retail', 'e.g. BigBasket, Blinkit, Zepto, Reliance Fresh — direct sourcing, wants consistent perishable quality, price not public'),
  ('contract_farming', 'Contract Farming', 'Pre-agreed/formula price with an input or processing company — reduces price-crash risk, often bundles inputs/advisory'),
  ('fpo_collective', 'FPO / Farmer Collective', 'Pooled bargaining via a farmer-owned producer company — best where an active collective exists for that crop locally')
on conflict (channel_key) do nothing;

-- Which channels are realistically accessible for a given crop in a given
-- district — qualitative starting hypothesis, needs field validation.
create table if not exists crop_channel_access (
  id uuid primary key default gen_random_uuid(),
  crop_id uuid references crops(id) not null,
  district_id uuid references districts(id) not null,
  channel_key text references selling_channels(channel_key) not null,
  typical_realization_vs_mandi numeric,  -- e.g. 1.10 = ~10% better than mandi, NULL if undocumented
  notes text,
  verified boolean not null default false,
  unique(crop_id, district_id, channel_key)
);

-- ============================================================
-- Crop rotation — rule-based, sourced from general agronomy (nutrient
-- demand + pest/disease cycle logic), pending validation against a
-- specific ICAR/State Agricultural University publication for Pune's
-- agro-climatic zone. See src/data/rotation-rules.json for the current
-- ruleset.
-- ============================================================

create table if not exists crop_families (
  id uuid primary key default gen_random_uuid(),
  family_key text not null unique,   -- 'legume' | 'cereal_grass' | 'nightshade' | etc.
  description text not null
);

alter table crops add column if not exists family_key text references crop_families(family_key);

create table if not exists rotation_rules (
  id uuid primary key default gen_random_uuid(),
  rule_key text not null unique,
  description text not null,
  severity text not null check (severity in ('avoid', 'prefer', 'informational')),
  verified boolean not null default false
);
