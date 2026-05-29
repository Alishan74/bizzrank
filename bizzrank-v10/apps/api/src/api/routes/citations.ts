import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth } from '../middleware/auth.js';
import { loadOrgContext, OrgRequest } from '../middleware/orgContext.js';
import { permissionService } from '../../domains/orgs/PermissionService.js';
import {
  hasBrightLocalKey, createBrightLocalCampaign,
  fetchBrightLocalResults, generateManualAudit,
} from '../../domains/citations/BrightLocalService.js';
const router = Router();
router.use(requireAuth, loadOrgContext);

router.get('/', async (req: OrgRequest, res) => {
  try {
    const ctx = req.orgContext!;
    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ error: 'businessId required' });
    if (!permissionService.canActOnBusiness(ctx, 'business.read', businessId as string)) {
      return res.status(403).json({ error: 'No access to this business' });
    }
    const { data } = await supabase.from('citation_audits')
      .select('*').eq('business_id', businessId as string)
      .order('created_at', { ascending: false }).limit(1).single();
    res.json({ audit: data ?? null, brightlocalEnabled: hasBrightLocalKey() });
  } catch { res.json({ audit: null, brightlocalEnabled: hasBrightLocalKey() }); }
});

router.post('/run', async (req: OrgRequest, res) => {
  try {
    const ctx = req.orgContext!;
    const { businessId } = req.body;
    if (!businessId) return res.status(400).json({ error: 'businessId required' });
    if (!permissionService.canActOnBusiness(ctx, 'business.edit', businessId)) {
      return res.status(403).json({ error: 'Cannot run audits for this business' });
    }

    const { data: biz } = await supabase.from('businesses')
      .select('name,address,phone,city,org_id').eq('id', businessId).single();
    if (!biz || biz.org_id !== ctx.orgId) return res.status(404).json({ error: 'Business not found' });

    const nextAuditDate = new Date();
    nextAuditDate.setDate(nextAuditDate.getDate() + 7);

    const { data: audit } = await supabase.from('citation_audits').insert({
      user_id: ctx.userId, business_id: businessId,
      reference_name: biz.name, reference_address: biz.address ?? '', reference_phone: biz.phone,
      status: hasBrightLocalKey() ? 'running' : 'no_api_key',
      next_audit_date: nextAuditDate.toISOString().split('T')[0],
    }).select().single();

    if (!audit) return res.status(500).json({ error: 'Failed to create audit' });
    res.status(201).json({ auditId: audit.id, brightlocalEnabled: hasBrightLocalKey() });
    runAuditBackground(audit.id, businessId, ctx.userId, biz.name, biz.address ?? '', biz.phone, null).catch(console.error);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

async function runAuditBackground(auditId: string, businessId: string, userId: string, name: string, address: string, phone: string | null, existingCampaignId: string | null) {
  try {
    let result;
    if (hasBrightLocalKey()) {
      const cId = existingCampaignId ?? await createBrightLocalCampaign(name, address, phone, null);
      await new Promise(r => setTimeout(r, 5000));
      result = await fetchBrightLocalResults(cId);
    } else {
      result = generateManualAudit(name, address, phone);
    }
    const nextAudit = new Date(); nextAudit.setDate(nextAudit.getDate() + 7);
    await supabase.from('citation_audits').update({
      results: result.results, conquest_tasks: result.conquestTasks,
      total_platforms: result.totalPlatforms, matching_platforms: result.matchingPlatforms,
      issues_found: result.issuesFound, health_score: result.healthScore,
      brightlocal_campaign_id: result.brightlocalCampaignId ?? null,
      status: 'completed', audited_at: new Date().toISOString(),
      next_audit_date: nextAudit.toISOString().split('T')[0],
    }).eq('id', auditId);
  } catch (err: any) {
    await supabase.from('citation_audits').update({ status: 'failed' }).eq('id', auditId);
  }
}

router.patch('/:auditId/task/:taskIndex/complete', async (req: OrgRequest, res) => {
  try {
    const ctx = req.orgContext!;
    const { data: audit } = await supabase.from('citation_audits')
      .select('conquest_tasks,matching_platforms,business_id')
      .eq('id', req.params.auditId).single();
    if (!audit) return res.status(404).json({ error: 'Audit not found' });
    if (!permissionService.canActOnBusiness(ctx, 'business.edit', audit.business_id)) {
      return res.status(403).json({ error: 'Cannot edit this audit' });
    }
    const tasks = audit.conquest_tasks as any[];
    const idx = parseInt(req.params.taskIndex);
    if (tasks[idx]) tasks[idx].completed = true;
    const completed = tasks.filter((t: any) => t.completed).length;
    await supabase.from('citation_audits')
      .update({ conquest_tasks: tasks, matching_platforms: completed }).eq('id', req.params.auditId);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
