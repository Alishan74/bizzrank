-- ============================================================
-- BizzRank AI v9 — Complete Fresh Schema
-- Run in Supabase SQL Editor → New Query → Run
-- ============================================================

-- Drop everything first
drop table if exists public.scan_jobs cascade;
drop table if exists public.serp_cache cascade;
drop table if exists public.leaderboard_scores cascade;
drop table if exists public.citation_audits cascade;
drop table if exists public.reviews cascade;
drop table if exists public.ad_scan_slots cascade;
drop table if exists public.ad_scan_sessions cascade;
drop table if exists public.organic_scores cascade;
drop table if exists public.organic_rankings cascade;
drop table if exists public.organic_scans cascade;
drop table if exists public.credit_transactions cascade;
drop table if exists public.discovered_businesses cascade;
drop table if exists public.gbp_pending_locations cascade;
drop table if exists public.competitors cascade;
drop table if exists public.businesses cascade;
drop table if exists public.profiles cascade;

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user cascade;

create extension if not exists "uuid-ossp";

-- ─── PROFILES ─────────────────────────────────────────────────
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  company_name text,
  plan text not null default 'starter',
  credits_balance integer not null default 100,
  monthly_allowance integer not null default 100,
  max_businesses integer not null default 1,
  max_competitors_per_location integer not null default 3,
  gbp_access_token text,
  gbp_refresh_token text,
  gbp_connected boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─── BUSINESSES ───────────────────────────────────────────────
create table public.businesses (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  address text,
  city text,
  country text default 'US',
  latitude numeric(10,7),
  longitude numeric(10,7),
  phone text,
  website text,
  category text,
  google_place_id text,
  gbp_location_id text,
  opening_hours jsonb,
  timezone text default 'UTC',
  brand_voice jsonb,
  rating numeric(3,2),
  review_count integer,
  last_review_sync timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ─── COMPETITORS ──────────────────────────────────────────────
create table public.competitors (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  address text,
  latitude numeric(10,7),
  longitude numeric(10,7),
  google_place_id text,
  phone text,
  website text,
  category text,
  rating numeric(3,2),
  display_order integer not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ─── ORGANIC SCANS ────────────────────────────────────────────
create table public.organic_scans (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  keyword text not null,
  targeting_method text not null default 'auto_grid'
    check (targeting_method in ('auto_grid','addresses','zip_codes')),
  radius_km numeric(8,2),
  grid_size integer,
  input_addresses jsonb,
  input_zip_codes jsonb,
  scan_points jsonb,
  total_points integer not null default 0,
  points_completed integer not null default 0,
  state text not null default 'pending'
    check (state in ('pending','running','completed','failed')),
  error_message text,
  credits_consumed integer not null default 1,
  scan_date date not null default current_date,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ─── ORGANIC RANKINGS ─────────────────────────────────────────
create table public.organic_rankings (
  id uuid primary key default uuid_generate_v4(),
  scan_id uuid not null references public.organic_scans(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null,
  keyword text not null,
  scan_date date not null,
  point_index integer not null,
  point_label text,
  location_name text,
  latitude numeric(10,7) not null,
  longitude numeric(10,7) not null,
  google_maps_url text,
  found_place_id text,
  found_business_name text,
  found_address text,
  found_phone text,
  found_rating numeric(3,2),
  found_review_count integer,
  rank_position integer,
  total_results integer,
  result_type text not null default 'organic',
  scanned_at timestamptz not null default now()
);

-- ─── ORGANIC SCORES ───────────────────────────────────────────
create table public.organic_scores (
  id uuid primary key default uuid_generate_v4(),
  scan_id uuid not null unique references public.organic_scans(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null,
  keyword text not null,
  scan_date date not null,
  organic_visibility_score numeric(5,2) not null default 0,
  organic_avg_ranking numeric(6,2),
  organic_territory_dominance numeric(5,2) not null default 0,
  organic_total_cells integer not null default 0,
  organic_ranked_cells integer not null default 0,
  organic_top3_cells integer not null default 0,
  organic_top10_cells integer not null default 0,
  organic_heatmap_points jsonb,
  competitor_scores jsonb,
  scanned_at timestamptz not null default now()
);

-- ─── LEADERBOARD SCORES ───────────────────────────────────────
create table public.leaderboard_scores (
  id uuid primary key default uuid_generate_v4(),
  scan_id uuid not null references public.organic_scans(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null,
  keyword text not null,
  scan_date date not null,
  place_id text not null,
  place_name text not null,
  place_address text,
  place_rating numeric(3,2),
  is_client_business boolean not null default false,
  green_dots integer not null default 0,
  yellow_dots integer not null default 0,
  red_dots integer not null default 0,
  total_appearances integer not null default 0,
  avg_rank numeric(6,2),
  leaderboard_rank integer not null default 1,
  created_at timestamptz not null default now()
);

-- ─── AD SCAN SESSIONS ─────────────────────────────────────────
create table public.ad_scan_sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  keyword text not null,
  scan_date date not null default current_date,
  targeting_method text not null default 'auto_grid',
  radius_km numeric(8,2),
  grid_size integer,
  input_addresses jsonb,
  input_zip_codes jsonb,
  business_ids uuid[] not null,
  interval_minutes integer not null default 90,
  scheduled_times jsonb,
  timezone text default 'UTC',
  state text not null default 'scheduled'
    check (state in ('scheduled','running','completed','stopped','failed')),
  scans_completed integer not null default 0,
  scans_total integer not null default 0,
  stopped_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ─── AD SCAN SLOTS ────────────────────────────────────────────
create table public.ad_scan_slots (
  id uuid primary key default uuid_generate_v4(),
  session_id uuid not null references public.ad_scan_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  slot_time text not null,
  slot_index integer not null,
  scheduled_at timestamptz,
  scan_points jsonb,
  state text not null default 'pending'
    check (state in ('pending','running','completed','failed','skipped')),
  ad_results jsonb,
  organic_results jsonb,
  pressure_score numeric(5,2),
  advertiser_count integer,
  organic_count integer,
  ad_density_map jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ─── SCAN JOBS (database-driven scheduler) ────────────────────
create table public.scan_jobs (
  id uuid primary key default uuid_generate_v4(),
  job_type text not null check (job_type in ('ad_slot','review_sync','citation_audit')),
  reference_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  scheduled_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  state text not null default 'pending'
    check (state in ('pending','running','completed','failed','skipped')),
  error_message text,
  retry_count integer not null default 0,
  created_at timestamptz not null default now()
);

-- ─── SERP CACHE ───────────────────────────────────────────────
create table public.serp_cache (
  id uuid primary key default uuid_generate_v4(),
  cache_key text not null unique,
  keyword text not null,
  latitude numeric(10,7) not null,
  longitude numeric(10,7) not null,
  results jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- ─── REVIEWS ──────────────────────────────────────────────────
create table public.reviews (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  source text not null default 'serp' check (source in ('gbp','serp')),
  google_review_id text unique,
  reviewer_name text,
  reviewer_photo_url text,
  rating integer not null check (rating between 1 and 5),
  review_text text,
  review_date timestamptz,
  is_replied boolean not null default false,
  ai_reply_draft text,
  ai_reply_status text not null default 'pending'
    check (ai_reply_status in ('pending','draft_ready','approved','posted','rejected')),
  requires_approval boolean not null default false,
  auto_reply_enabled boolean not null default true,
  posted_reply text,
  posted_at timestamptz,
  posted_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─── CITATION AUDITS ──────────────────────────────────────────
create table public.citation_audits (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  reference_name text not null,
  reference_address text not null,
  reference_phone text,
  brightlocal_campaign_id text,
  results jsonb not null default '[]',
  conquest_tasks jsonb not null default '[]',
  total_platforms integer not null default 0,
  matching_platforms integer not null default 0,
  issues_found integer not null default 0,
  health_score integer not null default 0,
  status text not null default 'pending',
  next_audit_date date,
  audited_at timestamptz,
  created_at timestamptz not null default now()
);

-- ─── DISCOVERED BUSINESSES ────────────────────────────────────
create table public.discovered_businesses (
  id uuid primary key default uuid_generate_v4(),
  google_place_id text not null unique,
  name text not null,
  address text,
  latitude numeric(10,7),
  longitude numeric(10,7),
  category text,
  rating numeric(3,2),
  review_count integer,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─── GBP PENDING ──────────────────────────────────────────────
create table public.gbp_pending_locations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  locations jsonb not null default '[]',
  created_at timestamptz not null default now()
);

-- ─── CREDIT TRANSACTIONS ──────────────────────────────────────
create table public.credit_transactions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount integer not null,
  balance_after integer not null,
  reason text not null,
  transaction_type text not null default 'usage',
  created_at timestamptz not null default now()
);

-- ─── INDEXES ──────────────────────────────────────────────────
create index idx_businesses_user on public.businesses(user_id);
create index idx_competitors_business on public.competitors(business_id);
create index idx_organic_scans_user on public.organic_scans(user_id);
create index idx_organic_scans_state on public.organic_scans(state);
create index idx_organic_rankings_scan on public.organic_rankings(scan_id);
create index idx_organic_rankings_place on public.organic_rankings(found_place_id);
create index idx_organic_scores_user on public.organic_scores(user_id);
create index idx_leaderboard_scan on public.leaderboard_scores(scan_id);
create index idx_leaderboard_business on public.leaderboard_scores(business_id, scan_date desc);
create index idx_ad_sessions_user on public.ad_scan_sessions(user_id);
create index idx_ad_slots_session on public.ad_scan_slots(session_id);
create index idx_ad_slots_state on public.ad_scan_slots(state);
create index idx_scan_jobs_state on public.scan_jobs(state, scheduled_at);
create index idx_scan_jobs_type on public.scan_jobs(job_type, state);
create index idx_serp_cache_key on public.serp_cache(cache_key);
create index idx_serp_cache_expires on public.serp_cache(expires_at);
create index idx_reviews_business on public.reviews(business_id);
create index idx_reviews_status on public.reviews(user_id, ai_reply_status);
create index idx_citation_business on public.citation_audits(business_id);

-- ─── RLS ──────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.businesses enable row level security;
alter table public.competitors enable row level security;
alter table public.organic_scans enable row level security;
alter table public.organic_rankings enable row level security;
alter table public.organic_scores enable row level security;
alter table public.leaderboard_scores enable row level security;
alter table public.ad_scan_sessions enable row level security;
alter table public.ad_scan_slots enable row level security;
alter table public.scan_jobs enable row level security;
alter table public.serp_cache enable row level security;
alter table public.reviews enable row level security;
alter table public.citation_audits enable row level security;
alter table public.gbp_pending_locations enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.discovered_businesses enable row level security;

create policy "own" on public.profiles for all using (auth.uid() = id);
create policy "own" on public.businesses for all using (auth.uid() = user_id);
create policy "own" on public.competitors for all using (auth.uid() = user_id);
create policy "own" on public.organic_scans for all using (auth.uid() = user_id);
create policy "own" on public.organic_rankings for all using (auth.uid() = user_id);
create policy "own" on public.organic_scores for all using (auth.uid() = user_id);
create policy "own" on public.leaderboard_scores for all using (auth.uid() = user_id);
create policy "own" on public.ad_scan_sessions for all using (auth.uid() = user_id);
create policy "own" on public.ad_scan_slots for all using (auth.uid() = user_id);
create policy "own" on public.scan_jobs for all using (auth.uid() = user_id);
create policy "own" on public.serp_cache for all using (true);
create policy "own" on public.reviews for all using (auth.uid() = user_id);
create policy "own" on public.citation_audits for all using (auth.uid() = user_id);
create policy "own" on public.gbp_pending_locations for all using (auth.uid() = user_id);
create policy "own" on public.credit_transactions for all using (auth.uid() = user_id);
create policy "read" on public.discovered_businesses for select using (auth.role() = 'authenticated');

-- ─── AUTO CREATE PROFILE ──────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, company_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''), new.raw_user_meta_data->>'company_name')
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

select 'BizzRank AI v9 schema complete!' as status;
