-- ============================================================
-- BizzRank AI — Review Intelligence Table
-- Run in Supabase SQL Editor before starting the API
-- ============================================================

create table if not exists public.review_intelligence (
  id                uuid primary key default uuid_generate_v4(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  positive_themes   jsonb not null default '[]',
  negative_themes   jsonb not null default '[]',
  emerging_themes   jsonb not null default '[]',
  summary           text,
  sentiment         text not null default 'neutral'
    check (sentiment in ('positive','neutral','negative')),
  trend             text not null default 'stable'
    check (trend in ('improving','stable','declining')),
  reviews_analyzed  integer not null default 0,
  generated_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  constraint review_intelligence_business_unique unique (business_id)
);

create index if not exists idx_review_intel_business
  on public.review_intelligence(business_id, generated_at desc);

alter table public.review_intelligence enable row level security;

create policy "Users see own review intelligence"
  on public.review_intelligence
  using (user_id = auth.uid());

-- Verify:
-- select count(*) from public.review_intelligence;   -- should be 0
