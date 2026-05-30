-- Migration 011: Master Fix
-- Run in Supabase SQL Editor

-- ── 1. Cleanup functions (were defined but never called) ──────
CREATE OR REPLACE FUNCTION public.cleanup_old_snapshots()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM public.gbp_snapshots
  WHERE captured_at < now() - INTERVAL '90 days';
  RAISE LOG '[Cleanup] gbp_snapshots pruned';
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_old_ai_visibility()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM public.ai_visibility_results
  WHERE checked_at < now() - INTERVAL '90 days';
  RAISE LOG '[Cleanup] ai_visibility_results pruned';
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_old_snapshots()    TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_ai_visibility() TO service_role;

-- ── 2. Performance indexes — missing from original setup ──────
-- organic_rankings by scan_id (needed for scan detail page)
CREATE INDEX IF NOT EXISTS idx_organic_rankings_scan_id
  ON public.organic_rankings(scan_id);

-- organic_rankings by business + date (needed for intelligence queries)
CREATE INDEX IF NOT EXISTS idx_organic_rankings_biz_date
  ON public.organic_rankings(business_id, scan_date DESC);

-- intel_signals cleanup index
CREATE INDEX IF NOT EXISTS idx_intel_signals_detected
  ON public.intel_signals(detected_at DESC);

-- reviews unanswered (needed for review sync queries)
CREATE INDEX IF NOT EXISTS idx_reviews_unanswered
  ON public.reviews(business_id, is_replied, review_date DESC)
  WHERE is_replied = false;

-- gbp_snapshots entity lookup
CREATE INDEX IF NOT EXISTS idx_gbp_snapshots_entity_date
  ON public.gbp_snapshots(entity_id, captured_at DESC);

-- ad_pressure_results by business + date
CREATE INDEX IF NOT EXISTS idx_ad_pressure_biz_date_v2
  ON public.ad_pressure_results(business_id, scan_date DESC)
  WHERE business_id IS NOT NULL;

-- ── 3. Fix credit_transactions constraint ─────────────────────
ALTER TABLE public.credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_transaction_type_check;

ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_transaction_type_check
  CHECK (transaction_type IN (
    'usage', 'refund', 'purchase', 'fixed_scan', 'monthly_reset', 'ai_check'
  ));

-- ── 4. Add updated_at to profiles if missing ─────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- ── 5. Verify
-- SELECT 'cleanup_old_snapshots' AS fn, pg_get_functiondef(oid) IS NOT NULL AS exists
-- FROM pg_proc WHERE proname = 'cleanup_old_snapshots';
