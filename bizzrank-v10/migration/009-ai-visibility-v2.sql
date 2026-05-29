-- Migration 009 v2: AI Visibility — World-Class Edition
-- Adds new columns for all advanced metrics
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS public.ai_visibility_results (
  id               uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id      uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  keyword          text        NOT NULL,
  city             text,

  -- Core scores (0-100)
  overall_score    integer     NOT NULL DEFAULT 0,
  chatgpt_score    integer     NOT NULL DEFAULT 0,
  perplexity_score integer     NOT NULL DEFAULT 0,
  gemini_score     integer     NOT NULL DEFAULT 0,

  -- Advanced metrics
  discovery_score  integer     NOT NULL DEFAULT 0,  -- score on discovery-intent prompts only
  sentiment_score  integer     NOT NULL DEFAULT 0,  -- -100 to +100
  share_of_voice   integer     NOT NULL DEFAULT 0,  -- % prompts where you appear first
  reliability      integer     NOT NULL DEFAULT 0,  -- avg appearance rate across 3 runs

  -- Trend
  trend            text        NOT NULL DEFAULT 'stable'
    CHECK (trend IN ('improving','stable','declining')),
  trend_delta      integer     NOT NULL DEFAULT 0,

  -- Intelligence
  top_insight      text,
  platform_gaps    jsonb       NOT NULL DEFAULT '[]',
  competitor_gaps  jsonb       NOT NULL DEFAULT '[]',
  root_causes      jsonb       NOT NULL DEFAULT '[]',
  actions          jsonb       NOT NULL DEFAULT '[]',

  -- Raw data
  prompt_results   jsonb       NOT NULL DEFAULT '[]',
  best_quote       text,
  worst_quote      text,
  prompts_tested   integer     NOT NULL DEFAULT 0,
  total_runs       integer     NOT NULL DEFAULT 0,

  checked_at       timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Add new columns to existing table if upgrading from v1
ALTER TABLE public.ai_visibility_results ADD COLUMN IF NOT EXISTS discovery_score  integer NOT NULL DEFAULT 0;
ALTER TABLE public.ai_visibility_results ADD COLUMN IF NOT EXISTS sentiment_score  integer NOT NULL DEFAULT 0;
ALTER TABLE public.ai_visibility_results ADD COLUMN IF NOT EXISTS share_of_voice   integer NOT NULL DEFAULT 0;
ALTER TABLE public.ai_visibility_results ADD COLUMN IF NOT EXISTS reliability      integer NOT NULL DEFAULT 0;
ALTER TABLE public.ai_visibility_results ADD COLUMN IF NOT EXISTS trend_delta      integer NOT NULL DEFAULT 0;
ALTER TABLE public.ai_visibility_results ADD COLUMN IF NOT EXISTS platform_gaps    jsonb   NOT NULL DEFAULT '[]';
ALTER TABLE public.ai_visibility_results ADD COLUMN IF NOT EXISTS competitor_gaps  jsonb   NOT NULL DEFAULT '[]';
ALTER TABLE public.ai_visibility_results ADD COLUMN IF NOT EXISTS root_causes      jsonb   NOT NULL DEFAULT '[]';
ALTER TABLE public.ai_visibility_results ADD COLUMN IF NOT EXISTS prompt_results   jsonb   NOT NULL DEFAULT '[]';
ALTER TABLE public.ai_visibility_results ADD COLUMN IF NOT EXISTS best_quote       text;
ALTER TABLE public.ai_visibility_results ADD COLUMN IF NOT EXISTS worst_quote      text;
ALTER TABLE public.ai_visibility_results ADD COLUMN IF NOT EXISTS total_runs       integer NOT NULL DEFAULT 0;
ALTER TABLE public.ai_visibility_results ADD COLUMN IF NOT EXISTS discovery_score  integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ai_visibility_biz    ON public.ai_visibility_results(business_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_visibility_user   ON public.ai_visibility_results(user_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_visibility_score  ON public.ai_visibility_results(business_id, overall_score DESC);

ALTER TABLE public.ai_visibility_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own AI visibility" ON public.ai_visibility_results;
CREATE POLICY "Users see own AI visibility"
  ON public.ai_visibility_results FOR ALL USING (user_id = auth.uid());

GRANT ALL ON public.ai_visibility_results TO service_role;
