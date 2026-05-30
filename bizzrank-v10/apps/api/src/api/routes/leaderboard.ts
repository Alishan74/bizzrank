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

    // Get the two most recent completed scans
    const { data: recentScans } = await supabase.from('organic_scans')
      .select('id, scan_date, keyword')
      .eq('business_id', businessId as string)
      .eq('state', 'completed')
      .order('created_at', { ascending: false })
      .limit(2);

    if (!recentScans?.length) {
      return res.json({ leaderboard: [], message: 'No completed scans found.' });
    }

    const latestScan   = recentScans[0];
    const previousScan = recentScans[1] ?? null;

    // Get current leaderboard
    const { data: leaderboard } = await supabase.from('leaderboard_scores')
      .select('*').eq('scan_id', latestScan.id).order('leaderboard_rank');

    // Get previous rank for the client business
    let prevRank: number | null     = null;
    let rankChange: number | null   = null;
    const currentEntry = (leaderboard ?? []).find((e: any) => e.is_client_business);
    const currentRank  = currentEntry?.leaderboard_rank ?? null;

    if (previousScan && currentRank !== null) {
      const { data: prevEntry } = await supabase.from('leaderboard_scores')
        .select('leaderboard_rank')
        .eq('scan_id', previousScan.id)
        .eq('is_client_business', true)
        .single();

      prevRank   = prevEntry?.leaderboard_rank ?? null;
      // Positive = moved up (was #5, now #3 = change +2)
      // Negative = moved down (was #3, now #5 = change -2)
      rankChange = (prevRank !== null && currentRank !== null)
        ? prevRank - currentRank
        : null;
    }

    res.json({
      leaderboard:  leaderboard ?? [],
      scanDate:     latestScan.scan_date,
      keyword:      latestScan.keyword,
      scanId:       latestScan.id,
      currentRank,
      prevRank,
      rankChange,   // positive = moved up, negative = moved down, null = first scan
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Leaderboard failed' });
  }
});

export default router;
