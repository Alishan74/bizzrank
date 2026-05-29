-- Migration 008: GBP Guard
-- Run in Supabase SQL Editor

-- GBP snapshots — daily point-in-time capture of all 20 monitored fields
CREATE TABLE IF NOT EXISTS public.gbp_snapshots (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_id       uuid NOT NULL,   -- business.id or competitor.id
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  is_competitor   boolean NOT NULL DEFAULT false,
  place_id        text,
  snapshot_data   jsonb NOT NULL,  -- full GBPSnapshot object
  captured_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gbp_snapshots_entity
  ON public.gbp_snapshots(entity_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_gbp_snapshots_user
  ON public.gbp_snapshots(user_id, captured_at DESC);

ALTER TABLE public.gbp_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own snapshots" ON public.gbp_snapshots;
CREATE POLICY "Users see own snapshots" ON public.gbp_snapshots
  FOR ALL USING (user_id = auth.uid());

GRANT ALL ON public.gbp_snapshots TO service_role;

-- GBP Guard alerts — change events detected between snapshots
CREATE TABLE IF NOT EXISTS public.gbp_guard_alerts (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_id       uuid NOT NULL,   -- business.id or competitor.id
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  is_competitor   boolean NOT NULL DEFAULT false,
  entity_name     text NOT NULL,
  field_name      text NOT NULL,   -- e.g. 'name', 'address', 'phone'
  field_label     text NOT NULL,   -- e.g. 'Business Name', 'Address'
  old_value       text,
  new_value       text,
  severity        text NOT NULL DEFAULT 'info'
    CHECK (severity IN ('critical','warning','info')),
  ai_explanation  text,
  is_read         boolean NOT NULL DEFAULT false,
  read_at         timestamptz,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gbp_alerts_user_unread
  ON public.gbp_guard_alerts(user_id, is_read, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_gbp_alerts_entity
  ON public.gbp_guard_alerts(entity_id, detected_at DESC);

ALTER TABLE public.gbp_guard_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own alerts" ON public.gbp_guard_alerts;
CREATE POLICY "Users see own alerts" ON public.gbp_guard_alerts
  FOR ALL USING (user_id = auth.uid());

GRANT ALL ON public.gbp_guard_alerts TO service_role;

-- Auto-cleanup: keep only 90 days of snapshots (they accumulate fast)
CREATE OR REPLACE FUNCTION public.cleanup_old_snapshots()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM public.gbp_snapshots
  WHERE captured_at < now() - INTERVAL '90 days';
END;
$$;

-- Verify
-- SELECT 'gbp_snapshots' as tbl, count(*) FROM public.gbp_snapshots
-- UNION ALL
-- SELECT 'gbp_guard_alerts', count(*) FROM public.gbp_guard_alerts;
