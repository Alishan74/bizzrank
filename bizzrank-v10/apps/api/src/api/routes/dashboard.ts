/**
 * Dashboard Route — single API call that powers the Overview page.
 *
 * Connections wired here:
 *   - GBP Guard summary (unread alert count + critical count)
 *     → Overview renders GBP Guard insight cards
 *   - AI Visibility latest score for primary business
 *     → Overview renders AI Visibility insight card when score is low
 *
 * ALL queries run in parallel — single round-trip to Supabase.
 * Zero new API calls — reads from tables already populated by crons.
 */
import { Router } from 'express';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { getPlan } from '../../domains/billing/BillingService.js';
import { getCacheConfidence, getIntelLevel } from '../../infrastructure/cache/CacheService.js';
import { intelligenceService } from '../../domains/intelligence/IntelligenceService.js';
import { gbpGuardService } from '../../domains/gbpguard/GBPGuardService.js';

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

  const plan       = profile?.plan ?? 'starter';
  const planConfig = getPlan(plan);

  // Secondary data for primary business — all parallel, all zero new API calls
  let intelLevel      = null;
  let cacheConfidence = null;
  let opportunityScore = null;
  let gbpGuard        = null;
  let aiVisibility    = null;

  if (businesses?.length) {
    const primaryBizId = businesses[0].id;

    [intelLevel, cacheConfidence, opportunityScore, gbpGuard, aiVisibility] = await Promise.all([
      getIntelLevel(uid),
      getCacheConfidence(primaryBizId),
      intelligenceService.computeOpportunityScore(primaryBizId, uid),

      // GBP Guard summary — unread + critical alert counts
      // Powers the GBP Guard insight cards in Overview
      gbpGuardService.getGuardSummary(uid).catch(() => null),

      // AI Visibility — latest score for primary business
      // Powers the AI Visibility insight card in Overview
      db.from('ai_visibility_results')
        .select('overall_score, discovery_score, sentiment_score, trend, trend_delta, top_insight, checked_at')
        .eq('business_id', primaryBizId)
        .eq('user_id', uid)
        .order('checked_at', { ascending: false })
        .limit(1)
        .single()
        .then(({ data }) => data ?? null)
        .catch(() => null),
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
    activeOrganicScans:  activeOrganicScans  ?? [],
    activeAdSessions:    activeAdSessions    ?? [],
    latestScores:        latestScores        ?? [],
    businesses:          businesses          ?? [],
    recentScans:         recentScans         ?? [],
    hasActiveScans:      (activeOrganicScans?.length ?? 0) > 0 || (activeAdSessions?.length ?? 0) > 0,
    intelligence: {
      level:       intelLevel    ?? { level: 0, reason: 'Monitoring active' },
      confidence:  cacheConfidence ?? { score: 100, changesDetected: false },
      opportunity: opportunityScore,
    },
    // ── NEW: GBP Guard summary for Overview insight cards ────
    gbpGuard: gbpGuard ? {
      totalUnread:     gbpGuard.totalUnread,
      criticalUnread:  gbpGuard.criticalUnread,
      lastChecked:     gbpGuard.lastChecked,
      alertsLast7Days: gbpGuard.alertsLast7Days,
    } : null,
    // ── NEW: AI Visibility latest score for Overview insight card ─
    aiVisibility: aiVisibility ? {
      overallScore:   aiVisibility.overall_score,
      discoveryScore: aiVisibility.discovery_score ?? 0,
      sentimentScore: aiVisibility.sentiment_score ?? 0,
      trend:          aiVisibility.trend,
      trendDelta:     aiVisibility.trend_delta ?? 0,
      topInsight:     aiVisibility.top_insight,
      checkedAt:      aiVisibility.checked_at,
    } : null,
    pollIntervalMs: 60000,
  });
});

export default router;
