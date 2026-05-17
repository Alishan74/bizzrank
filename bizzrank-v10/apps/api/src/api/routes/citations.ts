import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { hasBrightLocalKey, createBrightLocalCampaign, fetchBrightLocalResults, generateManualAudit } from '../../domains/citations/BrightLocalService.js';
import cron from 'node-cron';
const router = Router();

// Weekly auto-audit cron — runs every Monday at 9am
cron.schedule('0 9 * * 1', async () => {
  console.log('[Citations] Running weekly auto-audit...');
  const { data: dueAudits } = await supabase.from('citation_audits').select('id,business_id,user_id,brightlocal_campaign_id,reference_name,reference_address,reference_phone').lte('next_audit_date', new Date().toISOString().split('T')[0]).eq('status', 'completed');
  for (const audit of dueAudits ?? []) {
    await runAuditBackground(audit.id, audit.business_id, audit.user_id, audit.reference_name, audit.reference_address, audit.reference_phone, audit.brightlocal_campaign_id);
  }
});

router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  const { data } = await supabase.from('citation_audits').select('*').eq('business_id', businessId as string).eq('user_id', req.userId!).order('created_at', { ascending: false }).limit(1).single();
  res.json({ audit: data ?? null, brightlocalEnabled: hasBrightLocalKey() });
});

router.post('/run', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.body;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  const { data: biz } = await supabase.from('businesses').select('name,address,phone,city').eq('id', businessId).eq('user_id', req.userId!).single();
  if (!biz) return res.status(404).json({ error: 'Business not found' });

  const nextAuditDate = new Date();
  nextAuditDate.setDate(nextAuditDate.getDate() + 7);

  const { data: audit } = await supabase.from('citation_audits').insert({
    user_id: req.userId, business_id: businessId,
    reference_name: biz.name, reference_address: biz.address ?? '', reference_phone: biz.phone,
    status: hasBrightLocalKey() ? 'running' : 'no_api_key',
    next_audit_date: nextAuditDate.toISOString().split('T')[0],
  }).select().single();

  if (!audit) return res.status(500).json({ error: 'Failed to create audit' });

  res.status(201).json({ auditId: audit.id, brightlocalEnabled: hasBrightLocalKey() });
  runAuditBackground(audit.id, businessId, req.userId!, biz.name, biz.address ?? '', biz.phone, null).catch(console.error);
});

async function runAuditBackground(auditId: string, businessId: string, userId: string, name: string, address: string, phone: string | null, existingCampaignId: string | null) {
  try {
    let result;
    if (hasBrightLocalKey()) {
      const campaignId = existingCampaignId ?? await createBrightLocalCampaign(name, address, phone, null);
      await new Promise(r => setTimeout(r, 5000)); // wait for BrightLocal to process
      result = await fetchBrightLocalResults(campaignId);
    } else {
      result = generateManualAudit(name, address, phone);
    }
    const nextAudit = new Date();
    nextAudit.setDate(nextAudit.getDate() + 7);
    await supabase.from('citation_audits').update({
      results: result.results, conquest_tasks: result.conquestTasks,
      total_platforms: result.totalPlatforms, matching_platforms: result.matchingPlatforms,
      issues_found: result.issuesFound, health_score: result.healthScore,
      brightlocal_campaign_id: result.brightlocalCampaignId ?? null,
      status: 'completed', audited_at: new Date().toISOString(),
      next_audit_date: nextAudit.toISOString().split('T')[0],
    }).eq('id', auditId);
  } catch (err: any) {
    console.error('[Citations] Audit error:', err.message);
    await supabase.from('citation_audits').update({ status: 'failed' }).eq('id', auditId);
  }
}

router.patch('/:auditId/task/:taskIndex/complete', requireAuth, async (req: AuthRequest, res) => {
  const { data: audit } = await supabase.from('citation_audits').select('conquest_tasks,matching_platforms').eq('id', req.params.auditId).eq('user_id', req.userId!).single();
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  const tasks = audit.conquest_tasks as any[];
  const idx = parseInt(req.params.taskIndex);
  if (tasks[idx]) tasks[idx].completed = true;
  const completed = tasks.filter((t: any) => t.completed).length;
  await supabase.from('citation_audits').update({ conquest_tasks: tasks, matching_platforms: completed }).eq('id', req.params.auditId);
  res.json({ success: true });
});

export default router;
