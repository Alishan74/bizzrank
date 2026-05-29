import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth } from '../middleware/auth.js';
import { loadOrgContext, OrgRequest } from '../middleware/orgContext.js';
import { permissionService } from '../../domains/orgs/PermissionService.js';

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

    const { data: latestScan } = await supabase.from('organic_scans')
      .select('id, scan_date, keyword')
      .eq('business_id', businessId as string)
      .eq('state', 'completed')
      .order('created_at', { ascending: false })
      .limit(1).single();

    if (!latestScan) {
      return res.json({ leaderboard: [], message: 'No completed scans found.' });
    }

    const { data: leaderboard } = await supabase.from('leaderboard_scores')
      .select('*').eq('scan_id', latestScan.id).order('leaderboard_rank');

    res.json({
      leaderboard: leaderboard ?? [],
      scanDate: latestScan.scan_date, keyword: latestScan.keyword, scanId: latestScan.id,
    });
  } catch (err: any) { res.status(500).json({ error: err.message ?? 'Leaderboard failed' }); }
});

export default router;
