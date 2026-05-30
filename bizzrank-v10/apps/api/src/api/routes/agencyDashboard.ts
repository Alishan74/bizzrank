/**
 * Agency Dashboard API — /api/agency
 *
 * Returns consolidated data across ALL businesses in the org.
 * Powers the Agency Dashboard page for Pro/Agency/Enterprise plans.
 *
 * GET /agency/overview   — all businesses with their latest scores,
 *                          review stats, GBP alert counts, AI visibility
 * GET /agency/signals    — all intel signals across all businesses
 * GET /agency/compare    — side-by-side competitor comparison
 */
import { Router } from 'express';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.get('/overview', requireAuth, async (req: AuthRequest, res) => {
  const uid = req.userId!;

  // Load all active businesses
  const { data: businesses } = await db.from('businesses')
    .select('id, name, address, category, google_place_id, last_review_sync')
    .eq('user_id', uid).neq('is_active', false)
    .order('created_at', { ascending: true });

  if (!businesses?.length) return res.json({ businesses: [] });

  const bizIds = businesses.map((b: any) => b.id);

  // Load all data in parallel across all businesses
  const [
    { data: latestScores },
    { data: recentScans },
    { data: reviews },
    { data: gbpAlerts },
    { data: aiVisibility },
    { data: adSessions },
    { data: leaderboardScores },
    { data: keywords },
  ] = await Promise.all([
    // Latest organic score per business
    db.from('organic_scores')
      .select('business_id, organic_visibility_score, organic_avg_ranking, organic_top3_cells, organic_total_cells, scanned_at, keyword')
      .eq('user_id', uid).in('business_id', bizIds)
      .order('scanned_at', { ascending: false }).limit(bizIds.length * 4),

    // Recent scans with previous score for trend
    db.from('organic_scans')
      .select('business_id, keyword, state, created_at, organic_scores(organic_visibility_score)')
      .eq('user_id', uid).in('business_id', bizIds)
      .eq('state', 'completed')
      .order('created_at', { ascending: false }).limit(bizIds.length * 6),

    // Reviews per business
    db.from('reviews')
      .select('business_id, rating, is_replied, review_date')
      .eq('user_id', uid).in('business_id', bizIds),

    // Unread GBP Guard alerts per business
    db.from('gbp_guard_alerts')
      .select('business_id, severity, is_read, detected_at')
      .eq('user_id', uid).in('business_id', bizIds)
      .eq('is_read', false)
      .order('detected_at', { ascending: false }),

    // Latest AI visibility per business
    db.from('ai_visibility_results')
      .select('business_id, overall_score, discovery_score, trend, checked_at')
      .eq('user_id', uid).in('business_id', bizIds)
      .order('checked_at', { ascending: false }).limit(bizIds.length),

    // Active ad sessions
    db.from('ad_scan_sessions')
      .select('business_ids, keyword, state, created_at, scans_completed, scans_total')
      .eq('user_id', uid).in('state', ['scheduled', 'running'])
      .order('created_at', { ascending: false }),

    // Leaderboard rank per business
    db.from('leaderboard_scores')
      .select('business_id, leaderboard_rank, total_appearances')
      .eq('user_id', uid).eq('is_client_business', true)
      .in('business_id', bizIds)
      .order('scan_date', { ascending: false }).limit(bizIds.length),

    // Keywords per business
    db.from('business_keywords')
      .select('business_id, keyword')
      .in('business_id', bizIds).eq('is_active', true),
  ]);

  // Build per-business summary
  const summary = businesses.map((biz: any) => {
    const scores = (latestScores ?? []).filter((s: any) => s.business_id === biz.id);
    const latest = scores[0] ?? null;
    const prev   = scores.find((s: any) => s !== latest) ?? null;
    const score  = latest?.organic_visibility_score ?? null;
    const trend  = (score !== null && prev?.organic_visibility_score !== undefined)
      ? score - prev.organic_visibility_score : null;

    const bizReviews = (reviews ?? []).filter((r: any) => r.business_id === biz.id);
    const unanswered = bizReviews.filter((r: any) => !r.is_replied).length;
    const avgRating  = bizReviews.length > 0
      ? Math.round((bizReviews.reduce((s: number, r: any) => s + r.rating, 0) / bizReviews.length) * 10) / 10
      : null;
    const responseRate = bizReviews.length > 0
      ? Math.round(((bizReviews.length - unanswered) / bizReviews.length) * 100) : null;

    const bizAlerts   = (gbpAlerts ?? []).filter((a: any) => a.business_id === biz.id);
    const critAlerts  = bizAlerts.filter((a: any) => a.severity === 'critical').length;

    const aiVis       = (aiVisibility ?? []).find((a: any) => a.business_id === biz.id) ?? null;
    const lbRank      = (leaderboardScores ?? []).find((l: any) => l.business_id === biz.id)?.leaderboard_rank ?? null;
    const bizKeywords = (keywords ?? []).filter((k: any) => k.business_id === biz.id).map((k: any) => k.keyword);

    const lastScan    = (recentScans ?? []).find((s: any) => s.business_id === biz.id);
    const hasActiveScan = (adSessions ?? []).some((s: any) => s.business_ids?.includes(biz.id));

    // Health score: composite of visibility, review response, alerts
    let health = 0;
    if (score !== null) health += Math.round(score * 0.5);
    if (responseRate !== null) health += Math.round(responseRate * 0.3);
    if (critAlerts === 0) health += 20;
    else health -= critAlerts * 5;
    health = Math.max(0, Math.min(100, health));

    return {
      id:            biz.id,
      name:          biz.name,
      address:       biz.address,
      category:      biz.category,
      keywords:      bizKeywords,
      visibilityScore:  score,
      scoreTrend:       trend,
      avgRanking:       latest?.organic_avg_ranking ?? null,
      top3Zones:        latest?.organic_top3_cells ?? null,
      totalZones:       latest?.organic_total_cells ?? null,
      lastScanned:      latest?.scanned_at ?? null,
      lastScanKeyword:  latest?.keyword ?? null,
      reviews: {
        total:        bizReviews.length,
        unanswered,
        avgRating,
        responseRate,
      },
      gbpAlerts: {
        total:    bizAlerts.length,
        critical: critAlerts,
      },
      aiVisibility: aiVis ? {
        score:     aiVis.overall_score,
        discovery: aiVis.discovery_score,
        trend:     aiVis.trend,
      } : null,
      leaderboardRank:  lbRank,
      hasActiveScan,
      health,
    };
  });

  // Aggregate stats across all businesses
  const aggregate = {
    totalBusinesses:   summary.length,
    avgVisibility:     summary.filter((s: any) => s.visibilityScore !== null).length > 0
      ? Math.round(summary.filter((s: any) => s.visibilityScore !== null).reduce((a: number, b: any) => a + b.visibilityScore, 0) / summary.filter((s: any) => s.visibilityScore !== null).length) : null,
    totalUnanswered:   summary.reduce((a: number, b: any) => a + b.reviews.unanswered, 0),
    totalCritAlerts:   summary.reduce((a: number, b: any) => a + b.gbpAlerts.critical, 0),
    avgHealth:         Math.round(summary.reduce((a: number, b: any) => a + b.health, 0) / summary.length),
    businessesNeedingAttention: summary.filter((b: any) => b.health < 50 || b.gbpAlerts.critical > 0 || b.reviews.unanswered > 5).length,
  };

  res.json({ businesses: summary, aggregate });
});

router.get('/signals', requireAuth, async (req: AuthRequest, res) => {
  const uid = req.userId!;
  const { data } = await db.from('intel_signals')
    .select('*, businesses(name)')
    .eq('user_id', uid)
    .order('detected_at', { ascending: false })
    .limit(50);
  res.json({ signals: data ?? [] });
});

export default router;
