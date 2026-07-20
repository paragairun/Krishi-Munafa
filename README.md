# Krishi Munafa — Farmer Decision-Support Tool

**Mission:** Help a farmer in Maharashtra reason through what to grow, and how to sell it —
given their land, district, water access, and what they grew last season — without pretending
to predict the future for them.

## Live links

- **Engineer's debug dashboard**: https://paragairun.github.io/Krishi-Munafa/tools/debug-dashboard.html
  — internal tool only, English, exposes raw numbers. Not the farmer-facing product.
- **Backend (Supabase)**: not yet connected. `supabase/schema.sql` and
  `supabase/functions/get-crop-estimate/` are defined but no live project exists yet — see
  "Backend status" below. The debug dashboard above runs entirely standalone with data
  embedded directly in the HTML; it does not talk to Supabase at all right now.

## What this is, and isn't

This is a **decision-support tool, not a predictor**. It never shows a bare "Recommended /
Not Recommended" verdict, and — after testing exposed a real bug in an earlier version — it
never collapses to one composite "best" score either. It shows a shortlist of options across
different axes (earning, stability, soil health, water use) and lets the farmer see the actual
tradeoff, rather than the tool making that call silently on their behalf.

## Status: engine works, tested; real data collection hasn't started yet

The math has been stress-tested against a realistic (but explicitly illustrative, not sourced)
Pune-shaped crop mix and behaves sensibly. What's still missing is the real yield/price/cost
data for actual Pune crops — see "Next steps" below. Nothing in this repo should be shown to
a real farmer yet.

## How the recommendation engine works

```
Farmer input (district, acres, prior season's crop, irrigation, method)
        │
        ▼
profitEngine.ts — per-crop economics
        │  yield adjustment (irrigation, climate risk)
        │  cost build-up (seed+fert+pesticide+labour, methodology multiplier)
        │  price range (mandi min/max — other channels not wired in yet)
        ▼
portfolioEngine.ts — treats land allocation across crops as a
        │  portfolio problem (same math family as your trading system):
        │  each crop has a mean profit/acre and a volatility: combining
        │  crops with different risk profiles reduces overall swing.
        │  evaluateAllCombinations() scores every viable crop combo —
        │  does NOT pick one winner here.
        ▼
decisionShortlist.ts — the actual recommendation layer.
        │  Surfaces the best combo on EACH of several axes separately:
        │    - highest earning potential
        │    - most stable income (relative risk, not absolute rupees)
        │    - best for soil health (rotation-rule aligned)
        │    - most water-sustainable
        │    - balanced across all four
        │  Monocrop results are shown honestly, flagged with an explicit
        │  diversification-risk note, not hidden.
        ▼
rotationEngine.ts — sequences this across 2-3 years, calling
        │  decisionShortlist.ts fresh each year (not a single score) —
        │  every year returns its own 5-option shortlist. Hard-filters
        │  out families repeated from the prior year before scoring any
        │  axis. Threads sequencing through the "balanced" option by
        │  default as a preview assumption, not a recommendation.
```

### Why the design changed mid-build (worth knowing before touching this code)
An earlier version ranked crop combinations by a single risk-adjusted score (profit ÷ absolute
rupee variance). Testing it against a Pune-shaped crop mix — deliberately including crops at
very different value scales (Turmeric vs Gram) — showed the formula was silently penalizing
high-value crops just for having bigger absolute numbers, and near-tied scores were hiding
72%+ profit differences between options. The fix wasn't a better formula — it was recognizing
that collapsing multiple genuinely different goods (earning, stability, soil, water) into one
number was itself the mistake for a tool that's meant to support a decision, not make it.
`rotationEngine.ts` was then rewired to carry that same discipline into the multi-year preview
— each year gets a full shortlist too, not just Year 1.

### Why an Edge Function and not client-side lookup (like the old spreadsheet)
The old sheet's `#REF!` errors happened because its price lookup table lived in a sheet that
got deleted — a single point of failure. Server-side, live API responses get cached in
Supabase (`mandi_price_cache`), so the app stays fast and works even if data.gov.in is slow,
without ever losing the source table.

## Backend status: designed, not deployed

There is no live Supabase project behind this repo yet. What exists:

- `supabase/schema.sql` — full data model (crops, districts, baseline costs, live-price cache,
  selling channels, crop families/rotation rules) — a definition, not a running database
- `supabase/functions/get-crop-estimate/index.ts` — Edge Function with live Agmarknet fetch +
  cache + static-baseline fallback logic — written, not deployed anywhere

To actually connect this:
1. Create a free project at supabase.com
2. Run `supabase/schema.sql` in that project's SQL Editor
3. Deploy the Edge Function: `supabase functions deploy get-crop-estimate` (needs the Supabase
   CLI and the project linked)
4. Register a free data.gov.in API key and set it as the `AGMARKNET_API_KEY` secret
5. Update the project's URL/anon key wherever the frontend ends up calling it

Until this is done, the debug dashboard (and any future frontend) either needs to keep using
embedded/static data, or this setup needs to happen first. Worth deciding deliberately rather
than discovering it's missing later.

## What's in this repo

**Engine (`src/lib/`)**
- `profitEngine.ts` — single-crop, single-season profit math. Mandi pricing only so far;
  other selling channels aren't wired into the math yet.
- `portfolioEngine.ts` — multi-crop land-split optimization. `evaluateAllCombinations()` is
  the real entry point; `rankPortfolios()` is a single-lens convenience wrapper kept for
  internal use, documented as not the final word on its own.
- `decisionShortlist.ts` — **the actual recommendation layer.** Multi-axis shortlist, monocrop
  flagging, soil + water annotation.
- `rotationEngine.ts` — 2-3 year sequencing. **Now wired through `decisionShortlist.ts` for
  every year** — each year returns a full 5-option shortlist, hard-filtered against the prior
  year's crop family, sequenced via the "balanced" option as an explicit preview assumption.
  Tested end-to-end on the illustrative Pune dataset.

**Data (`src/data/`)**
- `maharashtra-baseline.json` — original starter dataset, UNVERIFIED numbers, kept for
  reference/testing.
- `pune-crops.json` — Pune district's actual crop list (grounded, cited to real sources) and
  a qualitative selling-channel matrix (DeHaat/Ninjacart/WayCool, BigBasket/Blinkit/Zepto/
  Reliance Fresh, contract farming, FPO collectives — see file for sourcing). **No yield/
  price/cost numbers yet** — that's the next real research task.
- `pune-baseline-TESTONLY.json` — illustrative Pune-shaped economics, explicitly built to
  stress-test the engine, not sourced, not for display to a farmer.
- `rotation-rules.json` — crop family tags + sequencing rules, general agronomy (nitrogen
  cycling, pest/disease carryover), not yet checked against an ICAR/MPKV Rahuri publication
  for Pune's specific agro-climatic zone.
- `water-intensity.json` — crop water-demand classification, general agronomic knowledge
  (rice/sugarcane as heavy users, tur/gram/jowar as drought-tolerant is well-established),
  still needs local verification for precision.

**Backend**
- `supabase/schema.sql` — data model: crops, districts, baseline costs, live-price cache,
  methodology/irrigation multipliers, selling channels + crop-channel access, crop families
  + rotation rules.
- `supabase/functions/get-crop-estimate/index.ts` — Edge Function: live Agmarknet fetch with
  cache and static-baseline fallback.

## Next steps, in order
1. Source real yield/price/cost numbers for the ~15 Pune crops in `pune-crops.json`,
   replacing `pune-baseline-TESTONLY.json` with the real thing. Best sources: Maharashtra's
   Cost of Cultivation reports, CACP, krishi.maharashtra.gov.in.
2. Validate `rotation-rules.json` against an actual MPKV Rahuri / ICAR publication for
   Pune's agro-climatic zone.
3. Field-check the channel access matrix — which aggregators/contract programs are actually
   reachable by a smallholder in Pune's specific talukas, not just active in the district.
4. Wire selling channels into the profit math (currently mandi-only).
5. Register a free data.gov.in API key for live mandi pricing.
6. Build the actual React UI (Simple + Advanced mode) — needs to render the shortlist as
   genuinely comparable cards, not a ranked list implying one option is "correct," and needs
   a way to let the farmer actually pick an option so next year's real filtering (not the
   preview's "balanced" assumption) can take over.
7. Deploy to Supabase + GitHub Pages, same pipeline as your other projects.
8. Expand district by district once Pune is trustworthy end-to-end.

Standing preference noted: complete file replacements over diffs, exact destination paths always stated.
