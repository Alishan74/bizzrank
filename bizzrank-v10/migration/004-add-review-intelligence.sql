-- ============================================================
-- BizzRank → Review Intelligence migration
--
-- Adds review_intelligence table: thematic clusters extracted
-- from each business's reviews via Gemini, refreshed weekly.
-- ============================================================

begin;

create table if not exists public.review_intelligence (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  analyzed_at timestamptz default now(),
  reviews_analyzed integer default 0,
  date_range_start date,
  date_range_end date,
  positive_themes jsonb default '[]'::jsonb,
  negative_themes jsonb default '[]'::jsonb,
  emerging_themes jsonb default '[]'::jsonb,
  overall_sentiment text check (overall_sentiment in ('positive', 'mixed', 'negative')),
  trending_direction text check (trending_direction in ('improving', 'stable', 'declining')),
  ai_summary text,
  created_at timestamptz default now()
);

create index if not exists idx_review_intel_business on public.review_intelligence(business_id);
create index if not exists idx_review_intel_analyzed on public.review_intelligence(analyzed_at desc);
create unique index if not exists uq_review_intel_business_date
  on public.review_intelligence(business_id, date(analyzed_at));

commit;
