-- Migration 009: AI Visibility
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS public.ai_visibility_results (
  id               uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id      uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  keyword          text        NOT NULL,
  city             text,
  overall_score    integer     NOT NULL DEFAULT 0,
  chatgpt_score    integer     NOT NULL DEFAULT 0,
  perplexity_score integer     NOT NULL DEFAULT 0,
  gemini_score     integer     NOT NULL DEFAULT 0,
  google_ai_score  integer     NOT NULL DEFAULT 0,
  prompts_tested   integer     NOT NULL DEFAULT 0,
  prompts_passed   integer     NOT NULL DEFAULT 0,
  share_of_voice   integer     NOT NULL DEFAULT 0,
  trend            text        NOT NULL DEFAULT 'stable'
    CHECK (trend IN ('improving','stable','declining')),
  top_insight      text,
  actions          jsonb       NOT NULL DEFAULT '[]',
  raw_results      jsonb       NOT NULL DEFAULT '[]',
  checked_at       timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_visibility_biz
  ON public.ai_visibility_results(business_id, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_visibility_user
  ON public.ai_visibility_results(user_id, checked_at DESC);

ALTER TABLE public.ai_visibility_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own AI visibility" ON public.ai_visibility_results;
CREATE POLICY "Users see own AI visibility"
  ON public.ai_visibility_results FOR ALL
  USING (user_id = auth.uid());

GRANT ALL ON public.ai_visibility_results TO service_role;

-- Auto-cleanup: keep 90 days
CREATE OR REPLACE FUNCTION public.cleanup_old_ai_visibility()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM public.ai_visibility_results
  WHERE checked_at < now() - INTERVAL '90 days';
END;
$$;

-- Verify
-- SELECT count(*) FROM public.ai_visibility_results;
