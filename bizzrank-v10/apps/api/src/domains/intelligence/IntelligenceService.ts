/**
 * IntelligenceService
 * L0 — Passive:  reads cache/DB, zero API calls
 * L2 — Daily:    full 25pt scan per keyword (replaces L1 single-point check)
 * L3 — Weekly:   processes 7 days of L2 data, generates report, ZERO new API calls
 *
 * Customer never sees L0/L2/L3 labels. No apiCostEstimate ever exposed.
 */
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { eventBus, Events } from '../../infrastructure/events/EventBus.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { enqueueOrganicScan } from '../../infrastructure/queue/QueueRegistry.js';
import { geoService } from '../geo/GeoService.js';
import {
  getCacheConfidence, setCacheConfidence, degradeCacheConfidence,
  type CacheConfidence,
} from '../../infrastructure/cache/CacheService.js';

export interface ChangeSignal {
  type: 'RankingDelta'|'VisibilityDelta'|'CompetitorDelta'|'ReviewDelta'|'AdPressureDelta';
  businessId: string; value: number; direction: 'up'|'down'|'spike'; detectedAt: string;
}

export class IntelligenceService {

  // ── L0: Passive — reads cache/DB only, zero API calls ────────
  async getPassiveIntelligence(businessId: string, userId: string) {
    const [
      { data: latestScore },
      { data: latestScans },
      { data: signals },
    ] = await Promise.all([
      db.from('organic_scores').select('*').eq('business_id', businessId).eq('user_id', userId)
        .order('scanned_at', { ascending: false }).limit(1).single(),
      db.from('organic_scans')
        .select('id, keyword, state, scan_date, organic_scores(organic_visibility_score, organic_avg_ranking, organic_top3_cells)')
        .eq('business_id', businessId).eq('user_id', userId)
        .eq('state', 'completed').order('scan_date', { ascending: false }).limit(10),
      db.from('intel_signals').select('*').eq('business_id', businessId)
        .order('detected_at', { ascending: false }).limit(20),
    ]);
    const confidence = await getCacheConfidence(businessId);
    return {
      latestScore: latestScore ?? null,
      latestScans: latestScans ?? [],
      recentSignals: signals ?? [],
      cacheConfidence: confidence,
    };
  }

  // ── L2: Daily full scan — 1am UTC, Standard Queue ─────────────
  // Full 25-point grid per keyword. Replaces L1 single-point check.
  // Competitor data extracted from same response — no extra API calls.
  async runDailyL2Scan(businessId: string, userId: string, keywords: string[]): Promise<ChangeSignal[]> {
    if (!keywords.length) return [];
    logger.info('[L2] Daily scan start', { businessId, keywords: keywords.length });

    const { data: biz } = await db.from('businesses')
      .select('latitude, longitude, google_place_id')
      .eq('id', businessId).single();
    if (!biz?.latitude || !biz?.longitude) return [];

    const { data: comps } = await db.from('competitors')
      .select('id, name, google_place_id').eq('business_id', businessId).neq('is_active', false);

    const points  = geoService.generateAutoGrid(biz.latitude, biz.longitude, 5, 3);
    const signals: ChangeSignal[] = [];

    for (const keyword of keywords) {
      try {
        const { data: scan } = await db.from('organic_scans').insert({
          user_id: userId, business_id: businessId, keyword,
          targeting_method: 'auto_grid', radius_km: 5, grid_size: 3,
          scan_points: points, total_points: points.length, points_completed: 0,
          state: 'pending', credits_consumed: 0,
          scan_date: new Date().toISOString().split('T')[0],
          is_automated: true, intel_level: 2,
        }).select().single();

        if (!scan) continue;

        // Read previous scores BEFORE enqueueing the new scan
        // so the comparison is baseline-vs-baseline, not baseline-vs-queued
        // (The enqueued scan is async — comparing after enqueue always
        //  reads the same 2 previous scores since the new scan hasn't run)
        const { data: prev } = await db.from('organic_scores')
          .select('organic_visibility_score')
          .eq('business_id', businessId).eq('user_id', userId)
          .order('scanned_at', { ascending: false }).limit(2);

        await enqueueOrganicScan({
          scanId: scan.id, userId, businessId,
          clientGooglePlaceId: biz.google_place_id,
          competitors: (comps ?? []).map(c => ({ id: c.id, name: c.name, googlePlaceId: c.google_place_id })),
          keyword, points, radiusKm: 5, isAutomated: true,
        });

        if (prev && prev.length >= 2) {
          const delta = (prev[0].organic_visibility_score ?? 0) - (prev[1].organic_visibility_score ?? 0);
          if (Math.abs(delta) >= 5) {
            const sig: ChangeSignal = {
              type: 'VisibilityDelta', businessId, value: Math.abs(delta),
              direction: delta > 0 ? 'up' : 'down', detectedAt: new Date().toISOString(),
            };
            signals.push(sig);
            await this.saveSignal(businessId, userId, sig);
            if (delta < -5) await degradeCacheConfidence(businessId, 'visibility_drop', 20);
          }
        }
      } catch (err: any) {
        logger.error('[L2] Scan failed', { businessId, keyword, error: err.message });
      }
    }

    // Check review spike
    const since24h = new Date(Date.now() - 86400000).toISOString();
    const { count: newReviews } = await db.from('reviews')
      .select('*', { count: 'exact', head: true })
      .eq('business_id', businessId).gte('created_at', since24h);

    if ((newReviews ?? 0) >= 5) {
      const sig: ChangeSignal = {
        type: 'ReviewDelta', businessId, value: newReviews ?? 0,
        direction: 'spike', detectedAt: new Date().toISOString(),
      };
      signals.push(sig);
      await this.saveSignal(businessId, userId, sig);
    }

    await setCacheConfidence(businessId, {
      score: signals.length > 0 ? 75 : 95,
      lastL3: (await getCacheConfidence(businessId))?.lastL3 ?? '',
      lastL1: new Date().toISOString(),
      changesDetected: signals.length > 0,
    });

    logger.info('[L2] Done', { businessId, signals: signals.length });
    return signals;
  }

  // ── L3: Weekly report — reads 7 days of L2 data, ZERO new API calls ─
  async runWeeklyReport(businessId: string, userId: string): Promise<void> {
    logger.info('[L3] Weekly report', { businessId });
    const since7d  = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const since14d = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];

    const { data: scores } = await db.from('organic_scores')
      .select('organic_visibility_score, scan_date, scanned_at')
      .eq('business_id', businessId).eq('user_id', userId)
      .gte('scan_date', since7d).order('scanned_at', { ascending: true });

    if (!scores?.length) return;

    const latest   = scores[scores.length - 1];
    const earliest = scores[0];
    const delta    = (latest.organic_visibility_score ?? 0) - (earliest.organic_visibility_score ?? 0);

    // Ad pressure trend from sponsored results already collected in ad_pressure_results
    const { data: adThis } = await db.from('ad_pressure_results')
      .select('place_id').eq('business_id', businessId).gte('scan_date', since7d);
    const { data: adLast } = await db.from('ad_pressure_results')
      .select('place_id').eq('business_id', businessId)
      .gte('scan_date', since14d).lt('scan_date', since7d);

    const adThisCount = new Set((adThis ?? []).map(r => r.place_id)).size;
    const adLastCount = new Set((adLast ?? []).map(r => r.place_id)).size;
    const adDelta     = adLastCount > 0 ? ((adThisCount - adLastCount) / adLastCount) * 100 : 0;

    if (Math.abs(delta) >= 3) {
      await this.saveSignal(businessId, userId, {
        type: 'VisibilityDelta', businessId, value: Math.abs(delta),
        direction: delta >= 0 ? 'up' : 'down', detectedAt: new Date().toISOString(),
      });
    }

    if (adDelta >= 20) {
      await this.saveSignal(businessId, userId, {
        type: 'AdPressureDelta', businessId, value: Math.round(adDelta),
        direction: 'spike', detectedAt: new Date().toISOString(),
      });
    }

    await setCacheConfidence(businessId, {
      score: 100, lastL3: new Date().toISOString(),
      lastL1: new Date().toISOString(), changesDetected: false,
    });

    logger.info('[L3] Report done', { businessId, delta, adDelta, scans: scores.length });
  }

  // ── Opportunity Score — zero API calls ────────────────────────
  async computeOpportunityScore(businessId: string, userId: string): Promise<{
    score: number; breakdown: Record<string, number>;
    trend: 'improving'|'stable'|'declining'; topAction: string;
  }> {
    const { data: scores } = await db.from('organic_scores')
      .select('organic_visibility_score, organic_territory_dominance, organic_top3_cells, organic_total_cells, scanned_at')
      .eq('business_id', businessId).eq('user_id', userId)
      .order('scanned_at', { ascending: false }).limit(2);

    if (!scores?.length) return {
      score: 0, breakdown: {}, trend: 'stable',
      topAction: 'Run your first scan to generate an Opportunity Score',
    };

    const latest   = scores[0];
    const previous = scores[1];
    const visComp  = (latest.organic_visibility_score ?? 0) * 0.40;
    const domComp  = (latest.organic_territory_dominance ?? 0) * 0.30;
    const top3Pct  = latest.organic_total_cells > 0
      ? (latest.organic_top3_cells / latest.organic_total_cells) * 100 : 0;
    const covComp  = top3Pct * 0.20;

    const { data: reviews } = await db.from('reviews')
      .select('rating').eq('business_id', businessId).order('review_date', { ascending: false }).limit(50);
    const avgRating = reviews?.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 3;
    const revComp   = ((avgRating - 1) / 4) * 100 * 0.10;
    const total     = Math.min(100, Math.round(visComp + domComp + covComp + revComp));

    let trend: 'improving'|'stable'|'declining' = 'stable';
    if (previous) {
      const diff = (latest.organic_visibility_score ?? 0) - (previous.organic_visibility_score ?? 0);
      if (diff > 3) trend = 'improving'; else if (diff < -3) trend = 'declining';
    }

    let topAction = 'Run more keywords to identify growth opportunities';
    if (top3Pct < 30)          topAction = 'Focus on ranking Top 3 in your core service zones';
    else if (avgRating < 4.2)  topAction = 'Improve review response rate to boost visibility score';
    else if ((latest.organic_visibility_score ?? 0) < 50) topAction = 'Optimise your Google Business Profile completeness';

    return {
      score: total,
      breakdown: { visibility: Math.round(visComp), dominance: Math.round(domComp), coverage: Math.round(covComp), reviews: Math.round(revComp) },
      trend, topAction,
    };
  }

  private async saveSignal(businessId: string, userId: string, signal: ChangeSignal): Promise<void> {
    try {
      await db.from('intel_signals').insert({
        business_id: businessId, user_id: userId, signal_type: signal.type,
        value: signal.value, direction: signal.direction,
        triggers_l2: false, detected_at: signal.detectedAt,
      });
    } catch { /* non-critical */ }
  }
}

export const intelligenceService = new IntelligenceService();
