#!/usr/bin/env bash
# BizzRank — Real Agency Dashboard
# cd /workspaces/bizzrank/bizzrank-v10 && bash real_agency.sh
set -e
ROOT="$(pwd)"
echo "Building real agency dashboard..."

# ── SQL migration for agency-specific tables ─────────────────
cat > "$ROOT/migration/012-agency-clients.sql" << 'SQLEOF'
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
SQLEOF

# ── Backend: real agency API ──────────────────────────────────
cat > "$ROOT/apps/api/src/api/routes/agency.ts" << 'EOF'
/**
 * Agency Route — /api/agency
 *
 * The real agency dashboard backend. Manages clients (not just businesses),
 * tracks work queues, controls credit allocation, and powers client reports.
 *
 * GET  /agency/dashboard       — full agency overview: clients, work queue, credits, team
 * GET  /agency/clients         — list all clients with their business health
 * POST /agency/clients         — create new client
 * GET  /agency/clients/:id     — single client deep view
 * PATCH /agency/clients/:id    — update client (budget, notes, status, fee)
 * DELETE /agency/clients/:id   — remove client
 * POST /agency/clients/:id/assign-business   — assign a business to a client
 * POST /agency/clients/:id/notes             — add internal note
 * GET  /agency/clients/:id/report-token      — get shareable report URL
 * GET  /agency/work-queue      — all unresolved tasks sorted by priority
 * POST /agency/work-queue/:id/resolve        — mark task done
 * POST /agency/work-queue/generate           — auto-generate tasks from current data
 * GET  /agency/credits         — credit usage breakdown per client
 * PATCH /agency/clients/:id/budget           — set monthly credit budget
 * GET  /agency/report/:token   — PUBLIC — client-facing report (no auth required)
 */
import { Router, Request, Response } from 'express';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────
async function getOrgId(userId: string): Promise<string | null> {
  const { data } = await db.from('organizations')
    .select('id').eq('owner_id', userId).single();
  if (data?.id) return data.id;
  // Also check if they're a member
  const { data: m } = await db.from('org_members')
    .select('org_id').eq('user_id', userId).limit(1).single();
  return m?.org_id ?? null;
}

async function requireOwnerOrManager(userId: string, orgId: string): Promise<boolean> {
  const { data } = await db.from('org_members')
    .select('role').eq('org_id', orgId).eq('user_id', userId).single();
  return ['owner', 'manager'].includes(data?.role ?? '');
}

// ── GET /agency/dashboard ─────────────────────────────────────
// The full agency control center in one API call
router.get('/dashboard', requireAuth, async (req: AuthRequest, res) => {
  const uid = req.userId!;
  const orgId = await getOrgId(uid);
  if (!orgId) return res.status(404).json({ error: 'No organization found' });

  const [
    { data: org },
    { data: clients },
    { data: workQueue },
    { data: members },
    { data: allBusinesses },
  ] = await Promise.all([
    db.from('organizations').select('*').eq('id', orgId).single(),
    db.from('agency_clients')
      .select('*').eq('org_id', orgId).eq('status', 'active')
      .order('name'),
    db.from('agency_work_queue')
      .select('*').eq('org_id', orgId).eq('resolved', false)
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true }).limit(50),
    db.from('org_members')
      .select('id, user_id, role, profiles(full_name)')
      .eq('org_id', orgId),
    db.from('businesses')
      .select('id, name, agency_client_id')
      .eq('user_id', uid).neq('is_active', false),
  ]);

  const clientIds = (clients ?? []).map((c: any) => c.id);

  // Per-client health snapshot (parallel)
  let clientHealth: any[] = [];
  if (clientIds.length > 0) {
    const [
      { data: scores },
      { data: reviews },
      { data: alerts },
      { data: aiVis },
    ] = await Promise.all([
      db.from('organic_scores')
        .select('business_id, organic_visibility_score, scanned_at')
        .eq('user_id', uid)
        .in('business_id', (allBusinesses ?? []).filter((b: any) => b.agency_client_id).map((b: any) => b.id))
        .order('scanned_at', { ascending: false })
        .limit((allBusinesses?.length ?? 1) * 3),
      db.from('reviews')
        .select('business_id, rating, is_replied')
        .eq('user_id', uid),
      db.from('gbp_guard_alerts')
        .select('business_id, severity')
        .eq('user_id', uid).eq('is_read', false),
      db.from('ai_visibility_results')
        .select('business_id, overall_score, trend')
        .eq('user_id', uid)
        .order('checked_at', { ascending: false })
        .limit((allBusinesses?.length ?? 1)),
    ]);

    clientHealth = (clients ?? []).map((client: any) => {
      const clientBizIds = (allBusinesses ?? [])
        .filter((b: any) => b.agency_client_id === client.id).map((b: any) => b.id);

      const latestScores = clientBizIds.map(bid =>
        (scores ?? []).find((s: any) => s.business_id === bid)
      ).filter(Boolean);

      const avgVis = latestScores.length > 0
        ? Math.round(latestScores.reduce((s: number, x: any) => s + x.organic_visibility_score, 0) / latestScores.length)
        : null;

      const clientReviews  = (reviews ?? []).filter((r: any) => clientBizIds.includes(r.business_id));
      const unanswered     = clientReviews.filter((r: any) => !r.is_replied).length;
      const avgRating      = clientReviews.length > 0
        ? Math.round((clientReviews.reduce((s: number, r: any) => s + r.rating, 0) / clientReviews.length) * 10) / 10 : null;

      const critAlerts     = (alerts ?? []).filter((a: any) => clientBizIds.includes(a.business_id) && a.severity === 'critical').length;
      const totalAlerts    = (alerts ?? []).filter((a: any) => clientBizIds.includes(a.business_id)).length;

      const bestAiVis      = (aiVis ?? []).find((a: any) => clientBizIds.includes(a.business_id));

      return {
        clientId:        client.id,
        name:            client.name,
        status:          client.status,
        monthlyFee:      client.monthly_fee,
        creditBudget:    client.monthly_credit_budget,
        creditsUsed:     client.credits_used_this_month,
        businessCount:   clientBizIds.length,
        avgVisibility:   avgVis,
        unansweredReviews: unanswered,
        avgRating,
        criticalAlerts:  critAlerts,
        totalAlerts,
        aiVisibility:    bestAiVis?.overall_score ?? null,
        aiTrend:         bestAiVis?.trend ?? null,
        reportToken:     client.report_token,
        contactEmail:    client.contact_email,
        contactName:     client.contact_name,
      };
    });
  }

  // Org-level credit summary
  const totalBudgeted   = (clients ?? []).reduce((s: number, c: any) => s + (c.monthly_credit_budget ?? 0), 0);
  const totalUsed       = (clients ?? []).reduce((s: number, c: any) => s + (c.credits_used_this_month ?? 0), 0);
  const orgCredits      = org?.credits_pool ?? 0;
  const unassignedBiz   = (allBusinesses ?? []).filter((b: any) => !b.agency_client_id).length;

  // Monthly revenue across clients
  const monthlyRevenue = (clients ?? []).reduce((s: number, c: any) => s + (c.monthly_fee ?? 0), 0);

  // Work queue priority counts
  const queueByCriticality = {
    critical: (workQueue ?? []).filter((t: any) => t.priority === 'critical').length,
    high:     (workQueue ?? []).filter((t: any) => t.priority === 'high').length,
    medium:   (workQueue ?? []).filter((t: any) => t.priority === 'medium').length,
    total:    (workQueue ?? []).length,
  };

  res.json({
    org,
    clientHealth,
    workQueue:      workQueue ?? [],
    queueSummary:   queueByCriticality,
    teamSize:       (members ?? []).length,
    credits: {
      pool:       orgCredits,
      budgeted:   totalBudgeted,
      used:       totalUsed,
      available:  orgCredits - totalUsed,
    },
    unassignedBusinesses: unassignedBiz,
    monthlyRevenue,
    activeClients: (clients ?? []).length,
  });
});

// ── GET /agency/clients ───────────────────────────────────────
router.get('/clients', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });
  const { data } = await db.from('agency_clients')
    .select('*').eq('org_id', orgId).order('name');
  res.json({ clients: data ?? [] });
});

// ── POST /agency/clients ──────────────────────────────────────
router.post('/clients', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });
  if (!await requireOwnerOrManager(req.userId!, orgId))
    return res.status(403).json({ error: 'Owner or manager required' });

  const { name, contactEmail, contactName, monthlyFee = 0, monthlyBudget = 0, notes = '' } = req.body;
  if (!name) return res.status(400).json({ error: 'Client name required' });

  const { data, error } = await db.from('agency_clients').insert({
    org_id: orgId, name, contact_email: contactEmail,
    contact_name: contactName, monthly_fee: monthlyFee,
    monthly_credit_budget: monthlyBudget, agency_notes: notes,
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ client: data });
});

// ── GET /agency/clients/:id ───────────────────────────────────
router.get('/clients/:clientId', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });

  const [{ data: client }, { data: businesses }, { data: notes }, { data: tasks }] = await Promise.all([
    db.from('agency_clients').select('*').eq('id', req.params.clientId).eq('org_id', orgId).single(),
    db.from('businesses').select('id, name, address, category')
      .eq('agency_client_id', req.params.clientId).eq('user_id', req.userId!),
    db.from('agency_client_notes').select('*, profiles(full_name)')
      .eq('client_id', req.params.clientId).order('created_at', { ascending: false }),
    db.from('agency_work_queue').select('*')
      .eq('client_id', req.params.clientId).eq('resolved', false)
      .order('priority', { ascending: true }),
  ]);

  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json({ client, businesses: businesses ?? [], notes: notes ?? [], tasks: tasks ?? [] });
});

// ── PATCH /agency/clients/:id ─────────────────────────────────
router.patch('/clients/:clientId', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });
  if (!await requireOwnerOrManager(req.userId!, orgId))
    return res.status(403).json({ error: 'Owner or manager required' });

  const allowed = ['name','contact_email','contact_name','monthly_fee','monthly_credit_budget','agency_notes','status'];
  const updates: any = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  updates.updated_at = new Date().toISOString();

  const { error } = await db.from('agency_clients')
    .update(updates).eq('id', req.params.clientId).eq('org_id', orgId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── DELETE /agency/clients/:id ────────────────────────────────
router.delete('/clients/:clientId', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });
  if (!await requireOwnerOrManager(req.userId!, orgId))
    return res.status(403).json({ error: 'Owner or manager required' });

  // Unassign businesses first, then delete client
  await db.from('businesses').update({ agency_client_id: null }).eq('agency_client_id', req.params.clientId);
  await db.from('agency_clients').delete().eq('id', req.params.clientId).eq('org_id', orgId);
  res.json({ success: true });
});

// ── POST /agency/clients/:id/assign-business ──────────────────
router.post('/clients/:clientId/assign-business', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });
  const { businessId } = req.body;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  await db.from('businesses').update({ agency_client_id: req.params.clientId })
    .eq('id', businessId).eq('user_id', req.userId!);
  res.json({ success: true });
});

// ── POST /agency/clients/:id/unassign-business ────────────────
router.post('/clients/:clientId/unassign-business', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.body;
  await db.from('businesses').update({ agency_client_id: null })
    .eq('id', businessId).eq('user_id', req.userId!);
  res.json({ success: true });
});

// ── POST /agency/clients/:id/notes ───────────────────────────
router.post('/clients/:clientId/notes', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });
  const { note } = req.body;
  if (!note?.trim()) return res.status(400).json({ error: 'Note required' });
  const { data } = await db.from('agency_client_notes').insert({
    client_id: req.params.clientId, org_id: orgId,
    author_id: req.userId!, note: note.trim(),
  }).select().single();
  res.status(201).json({ note: data });
});

// ── GET /agency/work-queue ────────────────────────────────────
router.get('/work-queue', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });
  const { data } = await db.from('agency_work_queue')
    .select('*, agency_clients(name)')
    .eq('org_id', orgId).eq('resolved', false)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(100);
  res.json({ tasks: data ?? [] });
});

// ── POST /agency/work-queue/:id/resolve ───────────────────────
router.post('/work-queue/:taskId/resolve', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });
  await db.from('agency_work_queue').update({
    resolved: true, resolved_at: new Date().toISOString(), resolved_by: req.userId!,
  }).eq('id', req.params.taskId).eq('org_id', orgId);
  res.json({ success: true });
});

// ── POST /agency/work-queue/generate ─────────────────────────
// Scans current data and creates actionable tasks
router.post('/work-queue/generate', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });
  const uid = req.userId!;

  const [
    { data: critAlerts },
    { data: unansweredReviews },
    { data: lowScores },
    { data: clients },
    { data: bizList },
  ] = await Promise.all([
    db.from('gbp_guard_alerts').select('business_id, field_name, new_value')
      .eq('user_id', uid).eq('severity', 'critical').eq('is_read', false).limit(20),
    db.from('reviews').select('business_id')
      .eq('user_id', uid).eq('is_replied', false)
      .lt('review_date', new Date(Date.now() - 3 * 86400000).toISOString())
      .limit(50),
    db.from('organic_scores').select('business_id, organic_visibility_score, scanned_at')
      .eq('user_id', uid).lt('organic_visibility_score', 25)
      .order('scanned_at', { ascending: false }).limit(20),
    db.from('agency_clients').select('id, name').eq('org_id', orgId),
    db.from('businesses').select('id, name, agency_client_id').eq('user_id', uid),
  ]);

  const tasks: any[] = [];
  const seen = new Set<string>();

  const clientFor = (bizId: string) =>
    (clients ?? []).find((c: any) =>
      (bizList ?? []).find((b: any) => b.id === bizId && b.agency_client_id === c.id)
    );
  const bizName = (bizId: string) =>
    (bizList ?? []).find((b: any) => b.id === bizId)?.name ?? 'Unknown business';

  // Critical GBP alerts → highest priority task
  for (const a of (critAlerts ?? [])) {
    const key = `gbp-${a.business_id}`;
    if (seen.has(key)) continue; seen.add(key);
    const client = clientFor(a.business_id);
    tasks.push({
      org_id: orgId, client_id: client?.id ?? null,
      business_id: a.business_id, priority: 'critical',
      task_type: 'gbp_alert',
      title: `Critical GBP change — ${bizName(a.business_id)}`,
      description: `"${a.field_name}" was changed to "${a.new_value}". Verify this is authorized.`,
      action_url: '/gbp-guard',
    });
  }

  // Reviews unanswered >3 days
  const bizUnanswered = new Map<string, number>();
  for (const r of (unansweredReviews ?? [])) {
    bizUnanswered.set(r.business_id, (bizUnanswered.get(r.business_id) ?? 0) + 1);
  }
  for (const [bizId, count] of bizUnanswered) {
    const client = clientFor(bizId);
    tasks.push({
      org_id: orgId, client_id: client?.id ?? null,
      business_id: bizId, priority: count >= 5 ? 'high' : 'medium',
      task_type: 'unanswered_reviews',
      title: `${count} unanswered review${count > 1 ? 's' : ''} — ${bizName(bizId)}`,
      description: `${count} review${count > 1 ? 's have' : ' has'} been waiting for a reply for 3+ days.`,
      action_url: '/reviews',
    });
  }

  // Low visibility scores
  for (const s of (lowScores ?? [])) {
    const key = `vis-${s.business_id}`;
    if (seen.has(key)) continue; seen.add(key);
    const client = clientFor(s.business_id);
    tasks.push({
      org_id: orgId, client_id: client?.id ?? null,
      business_id: s.business_id, priority: s.organic_visibility_score < 15 ? 'high' : 'medium',
      task_type: 'low_visibility',
      title: `Low visibility score (${s.organic_visibility_score}) — ${bizName(s.business_id)}`,
      description: `Visibility score is critically low. Run a fresh scan and review ranking changes.`,
      action_url: '/organic',
    });
  }

  if (tasks.length > 0) {
    // Clear old unresolved tasks of the same types before inserting fresh ones
    await db.from('agency_work_queue')
      .delete().eq('org_id', orgId).eq('resolved', false)
      .in('task_type', ['gbp_alert', 'unanswered_reviews', 'low_visibility']);
    await db.from('agency_work_queue').insert(tasks);
  }

  res.json({ generated: tasks.length, tasks });
});

// ── GET /agency/credits ───────────────────────────────────────
router.get('/credits', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });
  const [{ data: org }, { data: clients }] = await Promise.all([
    db.from('organizations').select('credits_pool, monthly_allowance').eq('id', orgId).single(),
    db.from('agency_clients')
      .select('id, name, monthly_credit_budget, credits_used_this_month')
      .eq('org_id', orgId).eq('status', 'active'),
  ]);
  res.json({
    pool:      org?.credits_pool ?? 0,
    allowance: org?.monthly_allowance ?? 0,
    clients:   (clients ?? []).map((c: any) => ({
      id: c.id, name: c.name,
      budget: c.monthly_credit_budget,
      used:   c.credits_used_this_month,
      pct:    c.monthly_credit_budget > 0
        ? Math.round((c.credits_used_this_month / c.monthly_credit_budget) * 100) : 0,
    })),
  });
});

// ── GET /agency/report/:token (PUBLIC — no auth) ──────────────
// Client-facing report. No login required. Token is unique per client.
router.get('/report/:token', async (req: Request, res: Response) => {
  const { data: client } = await db.from('agency_clients')
    .select('*, organizations(name)')
    .eq('report_token', req.params.token)
    .eq('status', 'active').single();

  if (!client) return res.status(404).json({ error: 'Report not found or expired' });

  const orgOwnerId = await db.from('organizations')
    .select('owner_id').eq('id', client.org_id).single()
    .then(r => r.data?.owner_id);

  const { data: businesses } = await db.from('businesses')
    .select('id, name').eq('agency_client_id', client.id);

  const bizIds = (businesses ?? []).map((b: any) => b.id);

  const [{ data: scores }, { data: reviews }, { data: alerts }, { data: aiVis }] = await Promise.all([
    db.from('organic_scores').select('*')
      .eq('user_id', orgOwnerId).in('business_id', bizIds)
      .order('scanned_at', { ascending: false }).limit(bizIds.length * 2),
    db.from('reviews').select('rating, is_replied, review_date')
      .eq('user_id', orgOwnerId).in('business_id', bizIds),
    db.from('gbp_guard_alerts').select('severity, field_name, detected_at')
      .eq('user_id', orgOwnerId).in('business_id', bizIds).eq('is_read', false)
      .order('detected_at', { ascending: false }).limit(5),
    db.from('ai_visibility_results').select('business_id, overall_score, trend')
      .eq('user_id', orgOwnerId).in('business_id', bizIds)
      .order('checked_at', { ascending: false }).limit(bizIds.length),
  ]);

  const avgVis = scores?.length
    ? Math.round((scores as any[]).reduce((s, x) => s + x.organic_visibility_score, 0) / scores.length) : 0;

  const reviewList = reviews ?? [];
  const unanswered = reviewList.filter((r: any) => !r.is_replied).length;
  const avgRating  = reviewList.length > 0
    ? (reviewList.reduce((s: number, r: any) => s + r.rating, 0) / reviewList.length).toFixed(1) : 'N/A';

  const agencyName = (client.organizations as any)?.name ?? 'Your Agency';
  const reportDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // Return a clean read-only HTML report — client opens this link
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${client.name} — Visibility Report</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;color:#111}
.header{background:#1D9E75;color:#fff;padding:32px 40px}
.header h1{font-size:26px;font-weight:900}.header p{opacity:.8;font-size:14px;margin-top:4px}
.container{max-width:900px;margin:0 auto;padding:32px 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:32px}
.card{background:#fff;border-radius:16px;padding:24px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.big{font-size:40px;font-weight:900;margin-bottom:4px}
.label{font-size:12px;color:#6b7280}
.section{background:#fff;border-radius:16px;padding:24px;margin-bottom:24px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.section h2{font-size:16px;font-weight:700;margin-bottom:16px;color:#1D9E75}
.biz{padding:12px;background:#f9fafb;border-radius:8px;margin-bottom:8px;display:flex;justify-content:space-between}
.alert-crit{background:#fef2f2;border-left:4px solid #dc2626;padding:10px 14px;border-radius:6px;margin-bottom:8px;font-size:13px}
.footer{text-align:center;color:#9ca3af;font-size:12px;padding:24px}
</style></head><body>
<div class="header">
  <h1>${client.name}</h1>
  <p>Visibility Report · Prepared by ${agencyName} · ${reportDate}</p>
</div>
<div class="container">
  <div class="grid">
    <div class="card"><div class="big" style="color:${avgVis >= 60 ? '#16a34a' : avgVis >= 30 ? '#f59e0b' : '#dc2626'}">${avgVis}</div><div class="label">Avg Visibility Score</div></div>
    <div class="card"><div class="big" style="color:${avgRating !== 'N/A' && parseFloat(avgRating) >= 4 ? '#16a34a' : '#f59e0b'}">${avgRating}★</div><div class="label">Average Rating</div></div>
    <div class="card"><div class="big" style="color:${unanswered > 0 ? '#f59e0b' : '#16a34a'}">${unanswered}</div><div class="label">Unanswered Reviews</div></div>
    <div class="card"><div class="big" style="color:${(alerts?.length ?? 0) > 0 ? '#dc2626' : '#16a34a'}">${alerts?.length ?? 0}</div><div class="label">GBP Alerts</div></div>
    ${(aiVis?.[0]?.overall_score) !== undefined ? `<div class="card"><div class="big" style="color:#7c3aed">${aiVis![0].overall_score}</div><div class="label">AI Visibility</div></div>` : ''}
  </div>

  <div class="section">
    <h2>Locations</h2>
    ${(businesses ?? []).map((b: any) => {
      const s = (scores ?? []).find((x: any) => x.business_id === b.id);
      return `<div class="biz"><span style="font-weight:600">${b.name}</span>${s ? `<span style="font-weight:700;color:${s.organic_visibility_score >= 60 ? '#16a34a' : s.organic_visibility_score >= 30 ? '#f59e0b' : '#dc2626'}">${s.organic_visibility_score}/100</span>` : '<span style="color:#ccc">No scans yet</span>'}</div>`;
    }).join('')}
  </div>

  ${(alerts?.length ?? 0) > 0 ? `<div class="section">
    <h2>Google Business Profile Alerts</h2>
    ${(alerts ?? []).map((a: any) => `<div class="alert-crit"><strong>${a.field_name}</strong> was changed · ${new Date(a.detected_at).toLocaleDateString()}</div>`).join('')}
  </div>` : ''}

  <div class="footer">Powered by ${agencyName} · ${reportDate} · This report is generated automatically</div>
</div></body></html>`);
});

export default router;
EOF

# Wire into index.ts
python3 -c "
path='apps/api/src/index.ts'
with open(path) as f: s = f.read()
# Replace old agency route with new one
if 'agencyRoutes' in s:
    s = s.replace(
        \"import agencyRoutes      from './api/routes/agencyDashboard.js';\",
        \"import agencyRoutes      from './api/routes/agency.js';\"
    )
else:
    s = s.replace(
        \"import reportsRoutes     from './api/routes/reports.js';\",
        \"import reportsRoutes     from './api/routes/reports.js';\nimport agencyRoutes      from './api/routes/agency.js';\"
    )
    s = s.replace(
        \"app.use('/api/reports',             reportsRoutes);\",
        \"app.use('/api/reports',             reportsRoutes);\napp.use('/api/agency',              agencyRoutes);\"
    )
open(path,'w').write(s)
print('agency route wired')
"

# Update api.ts
python3 -c "
path='apps/frontend/src/lib/api.ts'
with open(path) as f: s = f.read()
# Remove old stub
if 'agencyApi' in s:
    import re
    s = re.sub(r'export const agencyApi = \{[^}]*\};?\n?', '', s)
s += '''
export const agencyApi = {
  dashboard:         ()                       => api.get('/agency/dashboard'),
  clients:           ()                       => api.get('/agency/clients'),
  createClient:      (d: any)                 => api.post('/agency/clients', d),
  getClient:         (id: string)             => api.get('/agency/clients/' + id),
  updateClient:      (id: string, d: any)     => api.patch('/agency/clients/' + id, d),
  deleteClient:      (id: string)             => api.delete('/agency/clients/' + id),
  assignBusiness:    (clientId: string, businessId: string) => api.post('/agency/clients/' + clientId + '/assign-business', { businessId }),
  unassignBusiness:  (clientId: string, businessId: string) => api.post('/agency/clients/' + clientId + '/unassign-business', { businessId }),
  addNote:           (clientId: string, note: string) => api.post('/agency/clients/' + clientId + '/notes', { note }),
  workQueue:         ()                       => api.get('/agency/work-queue'),
  resolveTask:       (id: string)             => api.post('/agency/work-queue/' + id + '/resolve'),
  generateTasks:     ()                       => api.post('/agency/work-queue/generate'),
  credits:           ()                       => api.get('/agency/credits'),
};
'''
open(path,'w').write(s)
print('agencyApi updated')
"

# Remove old AgencyDashboard.tsx and replace with real one
cat > "$ROOT/apps/frontend/src/pages/AgencyDashboard.tsx" << 'JSEOF'
/**
 * Agency Dashboard — the real agency control center
 *
 * Built for Pro/Agency/Enterprise plans.
 *
 * WHAT THIS DOES THAT A NORMAL DASHBOARD DOESN'T:
 *
 * 1. CLIENT MANAGEMENT — not just your businesses, but clients you serve.
 *    Each client is a person/company. They have their own businesses,
 *    their own credit budget, their own shareable report URL.
 *    You add clients, assign businesses to them, track them separately.
 *
 * 2. WORK QUEUE — a prioritized list of actions your team needs to take.
 *    Auto-generated from: critical GBP alerts, unanswered reviews >3 days,
 *    low visibility scores. Click Generate to refresh. Click to resolve.
 *    Your team comes here every morning to see what needs doing.
 *
 * 3. CREDIT ALLOCATION — your plan has X credits.
 *    Each client gets a monthly budget. You see % used per client.
 *    No client can over-consume without you knowing.
 *
 * 4. CLIENT REPORTS — every client has a unique URL.
 *    You send it to them. They open it and see their data.
 *    No login required. Your brand on the report.
 *
 * 5. INTERNAL NOTES — leave notes on each client visible only to
 *    your team. Client sees nothing. Agency context preserved.
 *
 * 6. MONTHLY REVENUE TRACKING — record what you charge each client.
 *    See total monthly revenue across all clients at a glance.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { agencyApi, bizApi } from '../lib/api';

// ── Helpers ───────────────────────────────────────────────────
const PRIORITY_STYLE = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  high:     'bg-amber-100 text-amber-700 border-amber-200',
  medium:   'bg-blue-50 text-blue-700 border-blue-200',
  low:      'bg-gray-50 text-gray-500 border-gray-200',
};
const PRIORITY_ICON = { critical:'🚨', high:'⚠️', medium:'📋', low:'ℹ️' };
const TASK_TYPE_LABEL: Record<string,string> = {
  gbp_alert:          'GBP Alert',
  unanswered_reviews: 'Reviews',
  low_visibility:     'Visibility',
};

function ScoreDot({ v }: { v: number | null }) {
  if (v === null) return <span className="text-gray-300 text-xs">—</span>;
  const c = v >= 60 ? 'text-green-600' : v >= 30 ? 'text-amber-600' : 'text-red-600';
  return <span className={`font-bold text-sm ${c}`}>{v}</span>;
}

// ── Main component ─────────────────────────────────────────────
export default function AgencyDashboard() {
  const nav = useNavigate();
  const qc  = useQueryClient();
  const [view, setView] = useState<'overview'|'clients'|'queue'|'credits'>('overview');
  const [showAddClient, setShowAddClient] = useState(false);
  const [selectedClient, setSelectedClient] = useState<any>(null);
  const [newClient, setNewClient] = useState({ name:'', contactName:'', contactEmail:'', monthlyFee:0, monthlyBudget:0 });
  const [noteText, setNoteText] = useState('');
  const [generatingTasks, setGeneratingTasks] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['agency-dashboard'],
    queryFn:  () => agencyApi.dashboard().then(r => r.data),
    refetchInterval: 120000,
  });

  const { data: queueData } = useQuery({
    queryKey: ['agency-queue'],
    queryFn:  () => agencyApi.workQueue().then(r => r.data),
    enabled:  view === 'queue',
  });

  const { data: creditsData } = useQuery({
    queryKey: ['agency-credits'],
    queryFn:  () => agencyApi.credits().then(r => r.data),
    enabled:  view === 'credits',
  });

  const { data: clientDetail } = useQuery({
    queryKey: ['agency-client', selectedClient?.clientId],
    queryFn:  () => agencyApi.getClient(selectedClient.clientId).then(r => r.data),
    enabled:  !!selectedClient?.clientId,
  });

  const { data: bizList } = useQuery({
    queryKey: ['businesses'],
    queryFn:  () => bizApi.list().then(r => r.data.businesses),
    enabled:  !!selectedClient,
  });

  const createClient = useMutation({
    mutationFn: (d: any) => agencyApi.createClient(d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agency-dashboard'] }); setShowAddClient(false); setNewClient({ name:'', contactName:'', contactEmail:'', monthlyFee:0, monthlyBudget:0 }); },
  });

  const deleteClient = useMutation({
    mutationFn: (id: string) => agencyApi.deleteClient(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['agency-dashboard'] }); setSelectedClient(null); },
  });

  const resolveTask = useMutation({
    mutationFn: (id: string) => agencyApi.resolveTask(id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['agency-queue'] }),
  });

  const updateClient = useMutation({
    mutationFn: ({ id, data }: any) => agencyApi.updateClient(id, data),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['agency-client', selectedClient?.clientId] }),
  });

  const addNote = useMutation({
    mutationFn: ({ clientId, note }: any) => agencyApi.addNote(clientId, note),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['agency-client', selectedClient?.clientId] }); setNoteText(''); },
  });

  const assignBiz = useMutation({
    mutationFn: ({ clientId, businessId }: any) => agencyApi.assignBusiness(clientId, businessId),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['agency-client', selectedClient?.clientId] }); qc.invalidateQueries({ queryKey: ['businesses'] }); },
  });

  const dashboard = data;
  const clients: any[] = dashboard?.clientHealth ?? [];
  const tasks: any[]   = dashboard?.workQueue ?? [];

  if (isLoading) return (
    <div className="space-y-3">
      {[1,2,3].map(i => <div key={i} className="h-20 bg-gray-100 rounded-xl animate-pulse" />)}
    </div>
  );

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agency Dashboard</h1>
          <p className="text-gray-400 text-sm mt-0.5">{dashboard?.org?.name ?? 'Your Agency'}</p>
        </div>
        <button onClick={() => setShowAddClient(true)} className="btn-primary text-sm">+ Add Client</button>
      </div>

      {/* ── Tab bar ── */}
      <div className="flex border-b border-gray-200">
        {([
          { id: 'overview', label: '📊 Overview' },
          { id: 'clients',  label: `👥 Clients (${clients.length})` },
          { id: 'queue',    label: `📋 Work Queue${dashboard?.queueSummary?.critical > 0 ? ` 🚨${dashboard.queueSummary.critical}` : dashboard?.queueSummary?.total > 0 ? ` (${dashboard.queueSummary.total})` : ''}` },
          { id: 'credits',  label: '💳 Credits' },
        ] as const).map(t => (
          <button key={t.id} onClick={() => setView(t.id)}
            className={`px-4 py-3 text-sm font-medium transition-colors ${view === t.id ? 'border-b-2 border-brand-500 text-brand-700' : 'text-gray-500 hover:text-gray-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ══════════════════════ OVERVIEW ══════════════════════ */}
      {view === 'overview' && (
        <div className="space-y-5">

          {/* KPI bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
            {[
              { l:'Active Clients',      v: dashboard?.activeClients ?? 0,        c:'text-gray-800' },
              { l:'Monthly Revenue',     v: dashboard?.monthlyRevenue ? '$' + (dashboard.monthlyRevenue/100).toLocaleString() : '—', c:'text-green-600' },
              { l:'Unresolved Tasks',    v: dashboard?.queueSummary?.total ?? 0,  c: (dashboard?.queueSummary?.total ?? 0) > 0 ? 'text-amber-600' : 'text-green-600' },
              { l:'Critical Alerts',     v: dashboard?.queueSummary?.critical ?? 0, c: (dashboard?.queueSummary?.critical ?? 0) > 0 ? 'text-red-600' : 'text-green-600' },
              { l:'Credits Available',   v: (dashboard?.credits?.available ?? 0).toLocaleString(), c:'text-blue-600' },
            ].map(k => (
              <div key={k.l} className="bg-white border border-gray-100 rounded-xl p-4 text-center">
                <p className={`text-xl font-black ${k.c}`}>{k.v}</p>
                <p className="text-xs text-gray-400 mt-0.5">{k.l}</p>
              </div>
            ))}
          </div>

          {/* Urgent tasks preview */}
          {tasks.filter((t:any) => t.priority === 'critical' || t.priority === 'high').length > 0 && (
            <div className="bg-red-50 border border-red-100 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-red-800 text-sm">🚨 Needs immediate attention</h3>
                <button onClick={() => setView('queue')} className="text-xs text-red-600 font-semibold hover:underline">View all →</button>
              </div>
              <div className="space-y-2">
                {tasks.filter((t:any) => ['critical','high'].includes(t.priority)).slice(0, 3).map((t: any) => (
                  <div key={t.id} className="flex items-center justify-between bg-white rounded-lg px-3 py-2 shadow-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-base">{PRIORITY_ICON[t.priority as keyof typeof PRIORITY_ICON]}</span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-800 truncate">{t.title}</p>
                        {t.agency_clients?.name && <p className="text-xs text-gray-400">{t.agency_clients.name}</p>}
                      </div>
                    </div>
                    <button onClick={() => nav(t.action_url ?? '/overview')}
                      className="text-xs text-brand-600 font-semibold hover:underline shrink-0 ml-2">Fix →</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Client health table */}
          {clients.length === 0 ? (
            <div className="card text-center py-12">
              <p className="text-4xl mb-3">👥</p>
              <p className="font-semibold text-gray-700 mb-2">No clients yet</p>
              <p className="text-sm text-gray-400 mb-4">Add your first client, then assign your businesses to them</p>
              <button onClick={() => setShowAddClient(true)} className="btn-primary">Add first client</button>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    {['Client','Locations','Visibility','Reviews','GBP Alerts','AI Vis','Credits','Actions'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {clients.map((c: any) => (
                    <tr key={c.clientId}
                      className={`hover:bg-gray-50 transition-colors cursor-pointer ${c.criticalAlerts > 0 ? 'bg-red-50/40' : ''}`}
                      onClick={() => setSelectedClient(c)}>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-gray-800">{c.name}</p>
                        {c.contactName && <p className="text-xs text-gray-400">{c.contactName}</p>}
                        {c.monthlyFee > 0 && <p className="text-xs text-green-600 font-medium">${(c.monthlyFee/100).toFixed(0)}/mo</p>}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-center">{c.businessCount}</td>
                      <td className="px-4 py-3"><ScoreDot v={c.avgVisibility} /></td>
                      <td className="px-4 py-3">
                        {c.unansweredReviews > 0
                          ? <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">{c.unansweredReviews} unanswered</span>
                          : <span className="text-xs text-green-600">✓ Clear</span>}
                        {c.avgRating && <p className="text-xs text-gray-400 mt-0.5">★ {c.avgRating}</p>}
                      </td>
                      <td className="px-4 py-3">
                        {c.criticalAlerts > 0
                          ? <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold">🚨 {c.criticalAlerts} critical</span>
                          : c.totalAlerts > 0
                            ? <span className="text-xs text-amber-600">{c.totalAlerts} alerts</span>
                            : <span className="text-xs text-green-600">✓ Clear</span>}
                      </td>
                      <td className="px-4 py-3"><ScoreDot v={c.aiVisibility} /></td>
                      <td className="px-4 py-3">
                        {c.creditBudget > 0 ? (
                          <div>
                            <div className="flex items-center gap-1.5">
                              <div className="w-14 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${c.creditsUsed / c.creditBudget >= 0.9 ? 'bg-red-500' : 'bg-brand-500'}`}
                                  style={{ width: Math.min(100, Math.round((c.creditsUsed / c.creditBudget) * 100)) + '%' }} />
                              </div>
                              <span className="text-xs text-gray-500">{c.creditsUsed}/{c.creditBudget}</span>
                            </div>
                          </div>
                        ) : <span className="text-xs text-gray-300">No budget set</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1.5">
                          <button onClick={e => { e.stopPropagation(); window.open('/api/agency/report/' + c.reportToken, '_blank'); }}
                            title="Open client report" className="text-xs bg-green-50 text-green-600 px-2 py-1 rounded-lg hover:bg-green-100 font-medium">📄 Report</button>
                          <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(window.location.origin + '/api/agency/report/' + c.reportToken); alert('Report URL copied!'); }}
                            title="Copy report URL" className="text-xs bg-blue-50 text-blue-600 px-2 py-1 rounded-lg hover:bg-blue-100 font-medium">🔗 Copy</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════ CLIENTS DETAIL ════════════════ */}
      {view === 'clients' && !selectedClient && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">Click a client to manage them, assign businesses, set budgets, and add notes.</p>
          {clients.length === 0 ? (
            <div className="card text-center py-12">
              <p className="text-gray-400">No clients yet</p>
              <button onClick={() => setShowAddClient(true)} className="btn-primary mt-4">Add first client</button>
            </div>
          ) : clients.map((c: any) => (
            <div key={c.clientId} onClick={() => setSelectedClient(c)}
              className="card flex items-center justify-between cursor-pointer hover:border-brand-200 transition-colors">
              <div>
                <p className="font-semibold">{c.name}</p>
                <p className="text-sm text-gray-400">{c.businessCount} location{c.businessCount !== 1 ? 's' : ''} · {c.contactEmail ?? 'No email'}</p>
              </div>
              <div className="flex items-center gap-3">
                {c.criticalAlerts > 0 && <span className="text-xs bg-red-100 text-red-700 px-2 py-1 rounded-full">🚨 {c.criticalAlerts}</span>}
                <span className="text-gray-400 text-sm">→</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Client detail panel ── */}
      {view === 'clients' && selectedClient && (
        <div className="space-y-4">
          <button onClick={() => setSelectedClient(null)} className="text-sm text-gray-500 hover:text-gray-700">← Back to clients</button>

          <div className="card">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-xl font-bold">{selectedClient.name}</h2>
                {selectedClient.contactName && <p className="text-sm text-gray-500">{selectedClient.contactName} · {selectedClient.contactEmail}</p>}
              </div>
              <div className="flex gap-2">
                <button onClick={() => window.open('/api/agency/report/' + selectedClient.reportToken, '_blank')}
                  className="text-sm bg-green-50 text-green-700 px-3 py-1.5 rounded-xl font-medium hover:bg-green-100">📄 Client Report</button>
                <button onClick={() => { navigator.clipboard.writeText(window.location.origin + '/api/agency/report/' + selectedClient.reportToken); alert('Report URL copied to clipboard'); }}
                  className="text-sm bg-blue-50 text-blue-700 px-3 py-1.5 rounded-xl font-medium hover:bg-blue-100">🔗 Copy URL</button>
                <button onClick={() => { if (confirm('Remove this client? Businesses will be unassigned.')) deleteClient.mutate(selectedClient.clientId); }}
                  className="text-sm bg-red-50 text-red-600 px-3 py-1.5 rounded-xl font-medium hover:bg-red-100">Delete</button>
              </div>
            </div>

            {/* Editable fields */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Monthly fee (cents)', field: 'monthly_fee', type: 'number', val: selectedClient.monthlyFee },
                { label: 'Credit budget/month', field: 'monthly_credit_budget', type: 'number', val: selectedClient.creditBudget },
                { label: 'Contact email', field: 'contact_email', type: 'email', val: selectedClient.contactEmail ?? '' },
                { label: 'Contact name', field: 'contact_name', type: 'text', val: selectedClient.contactName ?? '' },
              ].map(f => (
                <div key={f.field}>
                  <label className="label text-xs">{f.label}</label>
                  <input type={f.type} defaultValue={f.val} className="input text-sm"
                    onBlur={e => updateClient.mutate({ id: selectedClient.clientId, data: { [f.field]: f.type === 'number' ? parseInt(e.target.value) || 0 : e.target.value } })} />
                </div>
              ))}
            </div>
          </div>

          {/* Assign businesses */}
          <div className="card">
            <h3 className="font-semibold mb-3">Businesses assigned to this client</h3>
            {clientDetail?.businesses?.length === 0 && <p className="text-sm text-gray-400 mb-3">No businesses assigned yet</p>}
            <div className="space-y-2 mb-3">
              {(clientDetail?.businesses ?? []).map((b: any) => (
                <div key={b.id} className="flex items-center justify-between p-2.5 bg-gray-50 rounded-xl">
                  <span className="text-sm font-medium">{b.name}</span>
                  <button onClick={() => agencyApi.unassignBusiness(selectedClient.clientId, b.id).then(() => qc.invalidateQueries({ queryKey: ['agency-client', selectedClient.clientId] }))}
                    className="text-xs text-red-500 hover:underline">Remove</button>
                </div>
              ))}
            </div>
            {/* Assign unassigned business */}
            {(bizList ?? []).filter((b: any) => !b.agency_client_id).length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1">Assign a business:</p>
                <select className="input text-sm"
                  onChange={e => { if (e.target.value) assignBiz.mutate({ clientId: selectedClient.clientId, businessId: e.target.value }); e.target.value = ''; }}>
                  <option value="">Select business to assign...</option>
                  {(bizList ?? []).filter((b: any) => !b.agency_client_id).map((b: any) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Internal notes */}
          <div className="card">
            <h3 className="font-semibold mb-3">Internal notes <span className="text-xs text-gray-400 font-normal">(only your team sees this)</span></h3>
            <div className="space-y-2 mb-3 max-h-40 overflow-y-auto">
              {(clientDetail?.notes ?? []).map((n: any) => (
                <div key={n.id} className="p-2.5 bg-gray-50 rounded-xl">
                  <p className="text-sm text-gray-700">{n.note}</p>
                  <p className="text-xs text-gray-400 mt-1">{n.profiles?.full_name ?? 'Team'} · {new Date(n.created_at).toLocaleString()}</p>
                </div>
              ))}
              {clientDetail?.notes?.length === 0 && <p className="text-xs text-gray-400">No notes yet</p>}
            </div>
            <div className="flex gap-2">
              <input className="input text-sm flex-1" placeholder="Add internal note..." value={noteText}
                onChange={e => setNoteText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && noteText.trim() && addNote.mutate({ clientId: selectedClient.clientId, note: noteText })} />
              <button onClick={() => noteText.trim() && addNote.mutate({ clientId: selectedClient.clientId, note: noteText })}
                className="btn-primary text-sm px-4" disabled={!noteText.trim()}>Add</button>
            </div>
          </div>

          {/* Open tasks for this client */}
          {clientDetail?.tasks?.length > 0 && (
            <div className="card">
              <h3 className="font-semibold mb-3">Open tasks</h3>
              <div className="space-y-2">
                {clientDetail.tasks.map((t: any) => (
                  <div key={t.id} className={`flex items-start justify-between p-3 border rounded-xl ${PRIORITY_STYLE[t.priority as keyof typeof PRIORITY_STYLE]}`}>
                    <div>
                      <span className="text-xs font-semibold mr-1">{PRIORITY_ICON[t.priority as keyof typeof PRIORITY_ICON]}</span>
                      <span className="text-sm font-medium">{t.title}</span>
                      {t.description && <p className="text-xs opacity-75 mt-0.5">{t.description}</p>}
                    </div>
                    <button onClick={() => resolveTask.mutate(t.id)} className="text-xs font-semibold ml-2 shrink-0 hover:underline">Done ✓</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════ WORK QUEUE ════════════════════ */}
      {view === 'queue' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500">
              Your team's daily action list. Auto-generated from GBP alerts, unanswered reviews, and low visibility scores.
            </p>
            <button onClick={async () => {
              setGeneratingTasks(true);
              try { await agencyApi.generateTasks(); qc.invalidateQueries({ queryKey: ['agency-queue'] }); qc.invalidateQueries({ queryKey: ['agency-dashboard'] }); }
              finally { setGeneratingTasks(false); }
            }} disabled={generatingTasks} className="btn-primary text-sm">
              {generatingTasks ? 'Generating...' : '⚡ Refresh tasks'}
            </button>
          </div>

          {!queueData?.tasks?.length ? (
            <div className="card text-center py-12">
              <p className="text-3xl mb-3">✅</p>
              <p className="font-semibold text-gray-700">No open tasks</p>
              <p className="text-sm text-gray-400 mt-1">Click "Refresh tasks" to scan for new items</p>
            </div>
          ) : (
            <div className="space-y-2">
              {['critical','high','medium','low'].map(priority => {
                const group = queueData.tasks.filter((t: any) => t.priority === priority);
                if (!group.length) return null;
                return (
                  <div key={priority}>
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1.5 mt-3">{priority} priority</p>
                    {group.map((t: any) => (
                      <div key={t.id} className={`flex items-start justify-between p-4 border rounded-xl mb-2 ${PRIORITY_STYLE[priority as keyof typeof PRIORITY_STYLE]}`}>
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          <span className="text-xl shrink-0">{PRIORITY_ICON[priority as keyof typeof PRIORITY_ICON]}</span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-semibold text-sm">{t.title}</p>
                              <span className="text-xs bg-white/70 px-1.5 py-0.5 rounded font-medium">{TASK_TYPE_LABEL[t.task_type] ?? t.task_type}</span>
                              {t.agency_clients?.name && <span className="text-xs opacity-70">{t.agency_clients.name}</span>}
                            </div>
                            {t.description && <p className="text-xs opacity-75 mt-0.5">{t.description}</p>}
                          </div>
                        </div>
                        <div className="flex gap-2 shrink-0 ml-2">
                          {t.action_url && (
                            <button onClick={() => nav(t.action_url)} className="text-xs font-semibold hover:underline px-2">Go →</button>
                          )}
                          <button onClick={() => resolveTask.mutate(t.id)}
                            className="text-xs bg-white/60 font-semibold px-3 py-1 rounded-lg hover:bg-white/90 transition-colors">
                            Done ✓
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════ CREDITS ════════════════════════ */}
      {view === 'credits' && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            {[
              { l:'Credit Pool',   v: (creditsData?.pool ?? 0).toLocaleString(),      c:'text-brand-600' },
              { l:'Budgeted',      v: (creditsData?.clients ?? []).reduce((s: number, c: any) => s + c.budget, 0).toLocaleString(), c:'text-amber-600' },
              { l:'Used this month', v: (creditsData?.clients ?? []).reduce((s: number, c: any) => s + c.used, 0).toLocaleString(), c:'text-red-500' },
            ].map(k => (
              <div key={k.l} className="card text-center">
                <p className={`text-2xl font-black ${k.c}`}>{k.v}</p>
                <p className="text-xs text-gray-400 mt-1">{k.l}</p>
              </div>
            ))}
          </div>

          <div className="card">
            <h3 className="font-semibold mb-4">Credit allocation per client</h3>
            <div className="space-y-3">
              {(creditsData?.clients ?? []).map((c: any) => (
                <div key={c.id}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-gray-500">{c.used} / {c.budget > 0 ? c.budget : '∞'} credits</span>
                  </div>
                  {c.budget > 0 && (
                    <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${c.pct >= 90 ? 'bg-red-500' : c.pct >= 70 ? 'bg-amber-400' : 'bg-brand-500'}`}
                        style={{ width: Math.min(100, c.pct) + '%' }} />
                    </div>
                  )}
                </div>
              ))}
              {(creditsData?.clients ?? []).length === 0 && (
                <p className="text-sm text-gray-400 text-center py-4">Add clients and set budgets to track credit allocation</p>
              )}
            </div>
          </div>

          <div className="card bg-blue-50 border-blue-100">
            <p className="text-sm text-blue-700">
              <strong>How credit budgets work:</strong> Each client gets a monthly credit budget from your plan's pool.
              Setting a budget doesn't deduct credits — it just sets a limit so one client can't use all your credits.
              Set budgets in the client detail view.
            </p>
          </div>
        </div>
      )}

      {/* ══════════════════════ ADD CLIENT MODAL ══════════════ */}
      {showAddClient && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-bold text-lg">Add new client</h3>
            <div>
              <label className="label">Client / company name *</label>
              <input className="input" value={newClient.name} onChange={e => setNewClient(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Smith Dental Practice" autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Contact name</label>
                <input className="input" value={newClient.contactName} onChange={e => setNewClient(p => ({ ...p, contactName: e.target.value }))} placeholder="John Smith" />
              </div>
              <div>
                <label className="label">Contact email</label>
                <input className="input" type="email" value={newClient.contactEmail} onChange={e => setNewClient(p => ({ ...p, contactEmail: e.target.value }))} placeholder="john@..." />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Monthly fee (in cents)</label>
                <input className="input" type="number" value={newClient.monthlyFee} onChange={e => setNewClient(p => ({ ...p, monthlyFee: parseInt(e.target.value)||0 }))} placeholder="e.g. 19900 = $199" />
                <p className="text-xs text-gray-400 mt-1">Display only — for your records</p>
              </div>
              <div>
                <label className="label">Credit budget/month</label>
                <input className="input" type="number" value={newClient.monthlyBudget} onChange={e => setNewClient(p => ({ ...p, monthlyBudget: parseInt(e.target.value)||0 }))} placeholder="e.g. 500" />
                <p className="text-xs text-gray-400 mt-1">Max credits this client can use</p>
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setShowAddClient(false)} className="flex-1 btn-secondary">Cancel</button>
              <button disabled={!newClient.name.trim() || createClient.isPending}
                onClick={() => createClient.mutate({ name: newClient.name, contactName: newClient.contactName, contactEmail: newClient.contactEmail, monthlyFee: newClient.monthlyFee, monthlyBudget: newClient.monthlyBudget })}
                className="flex-1 btn-primary">
                {createClient.isPending ? 'Creating...' : 'Create client'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
JSEOF

echo "  ✓ Agency Dashboard complete"
echo ""
echo "Run: migration/012-agency-clients.sql in Supabase, then npm run dev"
