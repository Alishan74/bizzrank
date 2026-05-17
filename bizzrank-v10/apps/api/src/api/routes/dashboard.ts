import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { getPlan } from '../../domains/billing/BillingService.js';

const router = Router();

router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const uid = req.userId!;

  const [
    { data: profile },
    { data: activeOrganicScans },
    { data: activeAdSessions },
    { data: latestScores },
    { data: businesses },
    { data: recentScans },
  ] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', uid).single(),
    supabase.from('organic_scans').select('*').eq('user_id', uid).in('state', ['pending', 'running']).order('created_at', { ascending: false }),
    supabase.from('ad_scan_sessions').select('*, ad_scan_slots(id, slot_time, state, pressure_score)').eq('user_id', uid).in('state', ['scheduled', 'running']).order('created_at', { ascending: false }),
    supabase.from('organic_scores').select('*').eq('user_id', uid).order('scanned_at', { ascending: false }).limit(5),
    supabase.from('businesses').select('id, name, latitude, longitude, google_place_id').eq('user_id', uid).eq('is_active', true),
    supabase.from('organic_scans').select('id, keyword, state, targeting_method, total_points, points_completed, created_at, organic_scores(organic_visibility_score)').eq('user_id', uid).order('created_at', { ascending: false }).limit(8),
  ]);

  const hasActiveScans = (activeOrganicScans?.length ?? 0) > 0 || (activeAdSessions?.length ?? 0) > 0;

  res.json({
    profile,
    planConfig: getPlan(profile?.plan ?? 'starter'),
    activeOrganicScans: activeOrganicScans ?? [],
    activeAdSessions: activeAdSessions ?? [],
    latestScores: latestScores ?? [],
    businesses: businesses ?? [],
    recentScans: recentScans ?? [],
    hasActiveScans,
    // Tell frontend how often to poll
    pollIntervalMs: hasActiveScans ? 3000 : 30000,
  });
});

export default router;
