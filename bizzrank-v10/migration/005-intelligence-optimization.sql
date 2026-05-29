-- ============================================================
-- BizzRank AI v10 — Intelligence + Optimization Migration
-- Run in Supabase SQL Editor → New Query → Run All
-- ============================================================
-- What this adds:
--   1. geo_cache          — permanent reverse geocode cache (kills Maps API spend)
--   2. business_keywords  — per-business keyword management with plan limits
--   3. intel_signals      — change detection feed from L1/L2/L3
--   4. intel_thresholds   — per-business L1→L2 escalation thresholds
--   5. organic_scans      — adds is_automated and intel_level columns
--   6. profiles           — aligns plan names with new pricing table
-- ============================================================

-- ─── 1. GEO CACHE ─────────────────────────────────────────────
-- Permanent storage for reverse geocoded coordinates.
-- key format: "lat:lng" rounded to 3 decimal places (~110m precision)
-- After first scan week, Google Maps Geocoding API calls approach zero.
create table if not exists public.geo_cache (
  lat_lng       text primary key,          -- "41.917:-87.682"
  location_name text not null,
  created_at    timestamptz not null default now()
);

-- Index for fast lookups (though primary key is already indexed)
comment on table public.geo_cache is
  'Permanent reverse geocode cache. Eliminates ~95% of Google Maps Geocoding API spend.';

-- RLS: service role only (no user-facing reads needed)
alter table public.geo_cache enable row level security;
create policy "Service role full access" on public.geo_cache
  using (true) with check (true);

-- ─── 2. BUSINESS KEYWORDS ─────────────────────────────────────
-- Keywords tracked per business. Drives weekly scans and L1 monitoring.
-- Plan limits enforced in API: Starter=1, Growth=2, Pro=3, Agency=4
create table if not exists public.business_keywords (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  business_id   uuid not null references public.businesses(id) on delete cascade,
  keyword       text not null,
  display_order integer not null default 1,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint business_keywords_unique unique (business_id, keyword)
);

create index if not exists idx_business_keywords_business
  on public.business_keywords(business_id) where is_active = true;

alter table public.business_keywords enable row level security;
create policy "Users manage own keywords" on public.business_keywords
  using (user_id = auth.uid()) with check (user_id = auth.uid());

comment on table public.business_keywords is
  'Keywords tracked per business. Each keyword drives weekly L3 scans and daily L1 checks.';

-- ─── 3. INTELLIGENCE SIGNALS ──────────────────────────────────
-- Change signals emitted by L1 and L2.
-- Powers the "Change Detection Feed" in the dashboard.
create table if not exists public.intel_signals (
  id           uuid primary key default uuid_generate_v4(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  signal_type  text not null check (signal_type in (
    'RankingDelta','VisibilityDelta','CompetitorDelta','ReviewDelta','AdPressureDelta'
  )),
  value        numeric(8,2) not null default 0,
  direction    text not null check (direction in ('up','down','spike')),
  triggers_l2  boolean not null default false,
  detected_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists idx_intel_signals_business
  on public.intel_signals(business_id, detected_at desc);

alter table public.intel_signals enable row level security;
create policy "Users see own signals" on public.intel_signals
  using (user_id = auth.uid());

-- Auto-cleanup: keep last 90 days only
create index if not exists idx_intel_signals_cleanup
  on public.intel_signals(detected_at);

-- ─── 4. INTELLIGENCE THRESHOLDS ───────────────────────────────
-- Per-business L1→L2 escalation thresholds.
-- Defaults: visibilityDrop=10%, competitorMovement=15pts,
--           reviewSpike=5, adPressureSpike=20
create table if not exists public.intel_thresholds (
  business_id          uuid primary key references public.businesses(id) on delete cascade,
  user_id              uuid not null references auth.users(id) on delete cascade,
  visibility_drop      integer not null default 10,
  competitor_movement  integer not null default 15,
  review_spike         integer not null default 5,
  ad_pressure_spike    integer not null default 20,
  updated_at           timestamptz not null default now()
);

alter table public.intel_thresholds enable row level security;
create policy "Users manage own thresholds" on public.intel_thresholds
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ─── 5. ORGANIC SCANS — add automation columns ────────────────
-- is_automated: true for weekly cron scans, false for user-triggered
-- intel_level: 1=L1, 2=L2-triggered, 3=L3-full

alter table public.organic_scans
  add column if not exists is_automated boolean not null default false;

alter table public.organic_scans
  add column if not exists intel_level integer check (intel_level in (1,2,3));

create index if not exists idx_organic_scans_automated
  on public.organic_scans(user_id, is_automated, scan_date desc);

comment on column public.organic_scans.is_automated is
  'true = weekly cron scan (consumes fixed credits), false = manual user scan (consumes user credits)';

-- ─── 6. PROFILES — align plan names with new pricing ──────────
-- The old schema had: starter, professional, agency, enterprise
-- New schema has:     starter, growth, pro, agency, enterprise
-- Migrate existing 'professional' → 'pro'

update public.profiles
  set plan = 'pro'
  where plan = 'professional';

-- Add 'growth' as valid option (no data migration needed — new plan)
comment on column public.profiles.plan is
  'Valid plans: starter($69), growth($119), pro($199), agency($799), enterprise(custom)';

-- ─── 7. CREDIT TRANSACTIONS — add new transaction types ───────
-- Existing: usage, refund, purchase
-- New: fixed_scan (automated weekly), monthly_reset

alter table public.credit_transactions
  drop constraint if exists credit_transactions_transaction_type_check;

alter table public.credit_transactions
  add constraint credit_transactions_transaction_type_check
  check (transaction_type in ('usage','refund','purchase','fixed_scan','monthly_reset'));

-- ─── 8. HELPER FUNCTION — get keywords for a business ─────────
create or replace function public.get_business_keywords(p_business_id uuid)
returns text[]
language sql stable
as $$
  select array_agg(keyword order by display_order)
  from public.business_keywords
  where business_id = p_business_id
    and is_active = true;
$$;

-- ─── VERIFICATION QUERIES ─────────────────────────────────────
-- Run these in a new SQL tab to confirm migration succeeded:
--
--   select count(*) from public.geo_cache;              -- 0 initially
--   select count(*) from public.business_keywords;      -- 0 initially
--   select count(*) from public.intel_signals;          -- 0 initially
--   select count(*) from public.intel_thresholds;       -- 0 initially
--   select column_name from information_schema.columns
--     where table_name = 'organic_scans'
--     and column_name in ('is_automated','intel_level'); -- should return 2 rows
--   select count(*) from public.profiles where plan = 'professional'; -- should be 0

-- ─── SEED: migrate existing scan keywords to business_keywords ─
-- Run this ONCE after migration to populate keywords from existing scans.
-- Each business gets its most recent scan keyword as keyword #1.
insert into public.business_keywords (user_id, business_id, keyword, display_order)
select distinct on (business_id)
  user_id, business_id, keyword, 1
from public.organic_scans
where state = 'completed'
order by business_id, created_at desc
on conflict (business_id, keyword) do nothing;

-- Done. ✓
