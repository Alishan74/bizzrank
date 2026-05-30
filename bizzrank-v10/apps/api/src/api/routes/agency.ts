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
import rateLimit from 'express-rate-limit';
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

// Rate limiter for the public report endpoint
// 30 requests per hour per IP — prevents scraping
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  message: { error: 'Too many requests' },
  standardHeaders: true, legacyHeaders: false,
});

// ── GET /agency/report/:token (PUBLIC — no auth) ──────────────
// Client-facing report. No login required. Token is unique per client.
router.get('/report/:token', reportLimiter, async (req: Request, res: Response) => {
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


// ── PATCH /agency/clients/:id/status ─────────────────────────
// Quick status toggle: active / paused / churned
router.patch('/clients/:clientId/status', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });
  const { status } = req.body;
  if (!['active','paused','churned'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  await db.from('agency_clients')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', req.params.clientId).eq('org_id', orgId);
  res.json({ success: true });
});

// ── POST /agency/clients/:id/rotate-token ────────────────────
// Regenerate the shareable report token (invalidates old URL)
router.post('/clients/:clientId/rotate-token', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });
  const { createRequire } = await import('module');
  const newToken = (await import('crypto')).randomBytes(24).toString('hex');
  await db.from('agency_clients')
    .update({ report_token: newToken, updated_at: new Date().toISOString() })
    .eq('id', req.params.clientId).eq('org_id', orgId);
  res.json({ success: true, token: newToken });
});

// ── GET /agency/analytics ─────────────────────────────────────
// Monthly trend: revenue, client count, avg visibility over time
router.get('/analytics', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });
  const uid = req.userId!;

  // Last 8 weeks of scan scores for trend
  const { data: scores } = await db.from('organic_scores')
    .select('organic_visibility_score, scanned_at')
    .eq('user_id', uid)
    .order('scanned_at', { ascending: false })
    .limit(200);

  // Group by week
  const weekMap = new Map<string, number[]>();
  for (const s of scores ?? []) {
    const d    = new Date(s.scanned_at);
    const week = d.toISOString().slice(0, 10).slice(0, 7); // YYYY-MM
    if (!weekMap.has(week)) weekMap.set(week, []);
    weekMap.get(week)!.push(s.organic_visibility_score);
  }

  const trend = [...weekMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([month, vals]) => ({
      month,
      avgScore: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
      scans: vals.length,
    }));

  // Review response rate over time
  const { data: reviews } = await db.from('reviews')
    .select('is_replied, review_date').eq('user_id', uid)
    .order('review_date', { ascending: false }).limit(500);

  const totalReviews    = reviews?.length ?? 0;
  const repliedReviews  = reviews?.filter((r: any) => r.is_replied).length ?? 0;
  const responseRate    = totalReviews > 0 ? Math.round((repliedReviews / totalReviews) * 100) : 0;

  // Client count over time (approximation from created_at)
  const { data: clients } = await db.from('agency_clients')
    .select('created_at, status').eq('org_id', orgId);

  res.json({ trend, responseRate, totalReviews, repliedReviews,
    clientStats: {
      total:  clients?.length ?? 0,
      active: clients?.filter((c: any) => c.status === 'active').length ?? 0,
      paused: clients?.filter((c: any) => c.status === 'paused').length ?? 0,
      churned: clients?.filter((c: any) => c.status === 'churned').length ?? 0,
    }
  });
});

// ── POST /agency/bulk-scan ────────────────────────────────────
// Trigger a manual scan for ALL businesses of a specific client
router.post('/bulk-scan', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const { data: businesses } = await db.from('businesses')
    .select('id, name').eq('agency_client_id', clientId).eq('user_id', req.userId!);

  if (!businesses?.length) return res.status(404).json({ error: 'No businesses for this client' });

  // Return list of businesses that need scanning — frontend navigates to /organic/new
  // We don't create scans here (credits need to be deducted per scan via organicScans route)
  res.json({
    businesses: businesses.map((b: any) => ({ id: b.id, name: b.name })),
    message: `${businesses.length} business${businesses.length > 1 ? 'es' : ''} ready to scan`,
  });
});

// ── GET /agency/export ────────────────────────────────────────
// Export all client data as JSON (for backup / reporting tools)
router.get('/export', requireAuth, async (req: AuthRequest, res) => {
  const orgId = await getOrgId(req.userId!);
  if (!orgId) return res.status(404).json({ error: 'No organization' });
  const uid = req.userId!;

  const [{ data: clients }, { data: members }, { data: org }] = await Promise.all([
    db.from('agency_clients').select('*').eq('org_id', orgId),
    db.from('org_members')
      .select('user_id, role, profiles(full_name)')
      .eq('org_id', orgId),
    db.from('organizations').select('name, plan, created_at').eq('id', orgId).single(),
  ]);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="bizzrank-export.json"');
  res.json({
    exportedAt: new Date().toISOString(),
    org: org ?? {},
    clients: (clients ?? []).map((c: any) => ({
      name: c.name, status: c.status,
      contactName: c.contact_name, contactEmail: c.contact_email,
      monthlyFee: c.monthly_fee, creditBudget: c.monthly_credit_budget,
      createdAt: c.created_at,
    })),
    teamSize: (members ?? []).length,
  });
});

export default router;
