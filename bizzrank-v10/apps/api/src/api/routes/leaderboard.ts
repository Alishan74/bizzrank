import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();

// GET /api/leaderboard?businessId=xxx
// Returns leaderboard from latest scan for this business
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  // Get latest completed scan for this business
  const { data: latestScan } = await supabase
    .from('organic_scans')
    .select('id, scan_date, keyword')
    .eq('business_id', businessId as string)
    .eq('user_id', req.userId!)
    .eq('state', 'completed')
    .order('scan_date', { ascending: false })
    .limit(1)
    .single();

  if (!latestScan) {
    return res.json({ leaderboard: [], message: 'No completed scans found. Run an organic scan to see the leaderboard.' });
  }

  const { data: leaderboard } = await supabase
    .from('leaderboard_scores')
    .select('*')
    .eq('scan_id', latestScan.id)
    .order('leaderboard_rank');

  res.json({
    leaderboard: leaderboard ?? [],
    scanDate: latestScan.scan_date,
    keyword: latestScan.keyword,
    scanId: latestScan.id,
  });
});

export default router;
