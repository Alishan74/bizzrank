/**
 * Dashboard Route
 * UPDATED:
 *   - pollIntervalMs always 60s — SSE handles real-time scan progress
 *   - Includes intelligence status (L0 passive — zero extra API calls)
 *   - Includes plan features so frontend knows what to show/hide
 *   - Opportunity score from cache
 */

import { Router } from 'express';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { getPlan } from '../../domains/billing/BillingService.js';
import { getCacheConfidence, getIntelLevel } from '../../infrastructure/cache/CacheService.js';
import { intelligenceService } from '../../domains/intelligence/IntelligenceService.js';

const router = Router();

router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const uid = req.userId!;

  // All parallel — single round trip to Supabase
  const [
    { data: profile },
    { data: activeOrganicScans },
    { data: activeAdSessions },
    { data: latestScores },
    { data: businesses },
    { data: recentScans },
  ] = await Promise.all([
    db.from('profiles').select('*').eq('id', uid).single(),
    db.from('organic_scans')
      .select('id, keyword, state, business_id, total_points, points_completed, created_at')
      .eq('user_id', uid)
      .in('state', ['pending', 'running'])
      .order('created_at', { ascending: false }),
    db.from('ad_scan_sessions')
      .select('*, ad_scan_slots(id, slot_time, state, pressure_score)')
      .eq('user_id', uid)
      .in('state', ['scheduled', 'running'])
      .order('created_at', { ascending: false }),
    db.from('organic_scores')
      .select('*')
      .eq('user_id', uid)
      .order('scanned_at', { ascending: false })
      .limit(5),
    db.from('businesses')
      .select('id, name, latitude, longitude, google_place_id')
      .eq('user_id', uid)
      .eq('is_active', true),
    db.from('organic_scans')
      .select('id, keyword, state, targeting_method, total_points, points_completed, created_at, organic_scores(organic_visibility_score)')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(8),
  ]);

  const plan = profile?.plan ?? 'starter';
  const planConfig = getPlan(plan);

  // Intel status — L0 passive, reads from Redis/DB only, zero API calls
  let intelLevel   = null;
  let cacheConfidence = null;
  let opportunityScore = null;

  if (businesses?.length) {
    const primaryBizId = businesses[0].id;
    [intelLevel, cacheConfidence, opportunityScore] = await Promise.all([
      getIntelLevel(uid),
      getCacheConfidence(primaryBizId),
      intelligenceService.computeOpportunityScore(primaryBizId, uid),
    ]);
  }

  res.json({
    profile,
    planConfig,
    planFeatures: {
      hasAiReplies:          planConfig.hasAiReplies,
      hasAutoPost:           planConfig.hasAutoPost,
      hasAdPressure:         planConfig.hasAdPressure,
      hasCitations:          planConfig.hasCitations,
      hasReviewIntelligence: planConfig.hasReviewIntelligence,
      hasL3Reports:          planConfig.hasL3Reports,
    },
    activeOrganicScans:  activeOrganicScans ?? [],
    activeAdSessions:    activeAdSessions ?? [],
    latestScores:        latestScores ?? [],
    businesses:          businesses ?? [],
    recentScans:         recentScans ?? [],
    hasActiveScans:      (activeOrganicScans?.length ?? 0) > 0 || (activeAdSessions?.length ?? 0) > 0,
    intelligence: {
      level:       intelLevel ?? { level: 0, reason: 'Monitoring active' },
      confidence:  cacheConfidence ?? { score: 100, changesDetected: false },
      opportunity: opportunityScore,
    },
    // FIXED: always 60s — SSE handles real-time progress, dashboard is overview only
    // The old 3s polling during active scans was creating 360 DB queries per scan
    pollIntervalMs: 60000,
  });
});

export default router;
