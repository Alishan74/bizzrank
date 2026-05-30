-- Migration 012: Agency Client Management
-- Run in Supabase SQL Editor

-- ── 1. agency_clients ────────────────────────────────────────
-- An agency_client is a relationship between the agency (org)
-- and a client they are managing. Each client can have:
--   - A name and contact info (stored by the agency)
--   - A monthly credit budget (how many of the agency's credits this client can use)
--   - A shareable report token (for client-facing reports with no login)
--   - Internal notes (only visible to the agency, never to the client)
--   - A status (active, paused, churned)
CREATE TABLE IF NOT EXISTS public.agency_clients (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  contact_email        text,
  contact_name         text,
  monthly_credit_budget integer NOT NULL DEFAULT 0,
  credits_used_this_month integer NOT NULL DEFAULT 0,
  report_token         text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  agency_notes         text,
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'paused', 'churned')),
  monthly_fee          integer DEFAULT 0,  -- what the agency charges this client (display only)
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agency_clients_org ON public.agency_clients(org_id);
CREATE INDEX IF NOT EXISTS idx_agency_clients_token ON public.agency_clients(report_token);

-- ── 2. Link existing businesses to agency clients ─────────────
-- A business can belong to a client
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS agency_client_id uuid REFERENCES public.agency_clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_businesses_client ON public.businesses(agency_client_id);

-- ── 3. agency_client_notes ───────────────────────────────────
-- Per-client internal notes log (separate from the single notes field)
CREATE TABLE IF NOT EXISTS public.agency_client_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES public.agency_clients(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL,
  author_id    uuid NOT NULL REFERENCES auth.users(id),
  note         text NOT NULL,
  created_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_notes_client ON public.agency_client_notes(client_id);

-- ── 4. agency_work_queue ─────────────────────────────────────
-- Auto-populated actionable tasks for the agency team
-- Created by: GBP Guard alerts, visibility drops, unanswered reviews
CREATE TABLE IF NOT EXISTS public.agency_work_queue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id    uuid REFERENCES public.agency_clients(id) ON DELETE CASCADE,
  business_id  uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  task_type    text NOT NULL,
  priority     text NOT NULL DEFAULT 'medium'
               CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  title        text NOT NULL,
  description  text,
  action_url   text,
  resolved     boolean NOT NULL DEFAULT false,
  resolved_at  timestamptz,
  resolved_by  uuid REFERENCES auth.users(id),
  created_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_queue_org      ON public.agency_work_queue(org_id, resolved, priority);
CREATE INDEX IF NOT EXISTS idx_work_queue_client   ON public.agency_work_queue(client_id, resolved);

-- ── 5. RLS ───────────────────────────────────────────────────
ALTER TABLE public.agency_clients     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agency_client_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agency_work_queue  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members see clients"   ON public.agency_clients;
DROP POLICY IF EXISTS "org members see notes"     ON public.agency_client_notes;
DROP POLICY IF EXISTS "org members see queue"     ON public.agency_work_queue;

CREATE POLICY "org members see clients"
  ON public.agency_clients FOR ALL
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

CREATE POLICY "org members see notes"
  ON public.agency_client_notes FOR ALL
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

CREATE POLICY "org members see queue"
  ON public.agency_work_queue FOR ALL
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

GRANT ALL ON public.agency_clients      TO service_role;
GRANT ALL ON public.agency_client_notes TO service_role;
GRANT ALL ON public.agency_work_queue   TO service_role;
