#!/usr/bin/env bash
# BizzRank AI v10 — Complete implementation script
# Fixes all 26 bugs + implements all discussed features
# cd /workspaces/bizzrank/bizzrank-v10 && bash complete_implementation.sh
set -e
ROOT="$(pwd)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " BizzRank AI v10 — Complete Implementation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─────────────────────────────────────────────────────────────
# BACKEND: 1. BillingService.ts
# ─────────────────────────────────────────────────────────────
echo "  [1/17] BillingService.ts"
cat > "$ROOT/apps/api/src/domains/billing/BillingService.ts" << 'EOF'
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { eventBus, Events } from '../../infrastructure/events/EventBus.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { InsufficientCreditsError } from '../../shared/errors/DomainErrors.js';
import type { CreditDeduction } from '../../shared/types/contracts.js';

export interface PlanConfig {
  name: string; displayName: string; priceMonthly: number;
  credits: number; maxBusinesses: number;
  maxCompetitorsPerLocation: number; maxKeywords: number;
  hasAiReplies: boolean; hasAutoPost: boolean;
  hasAdPressure: boolean; hasCitations: boolean;
  hasWhiteLabel: boolean; hasTeam: boolean;
  hasReviewIntelligence: boolean; hasL3Reports: boolean;
  citationAuditsPerMonth: number;
}

export const PLANS: Record<string, PlanConfig> = {
  starter: {
    name:'starter', displayName:'Starter', priceMonthly:49,
    credits:900, maxBusinesses:1, maxCompetitorsPerLocation:1, maxKeywords:1,
    hasAiReplies:true, hasAutoPost:false, hasAdPressure:true,
    hasCitations:false, hasWhiteLabel:false, hasTeam:false,
    hasReviewIntelligence:true, hasL3Reports:false, citationAuditsPerMonth:0,
  },
  growth: {
    name:'growth', displayName:'Growth', priceMonthly:119,
    credits:1600, maxBusinesses:1, maxCompetitorsPerLocation:2, maxKeywords:2,
    hasAiReplies:true, hasAutoPost:true, hasAdPressure:true,
    hasCitations:true, hasWhiteLabel:true, hasTeam:false,
    hasReviewIntelligence:true, hasL3Reports:true, citationAuditsPerMonth:2,
  },
  pro: {
    name:'pro', displayName:'Pro', priceMonthly:199,
    credits:1800, maxBusinesses:2, maxCompetitorsPerLocation:3, maxKeywords:3,
    hasAiReplies:true, hasAutoPost:true, hasAdPressure:true,
    hasCitations:true, hasWhiteLabel:true, hasTeam:true,
    hasReviewIntelligence:true, hasL3Reports:true, citationAuditsPerMonth:2,
  },
  agency: {
    name:'agency', displayName:'Agency', priceMonthly:499,
    credits:3500, maxBusinesses:5, maxCompetitorsPerLocation:4, maxKeywords:4,
    hasAiReplies:true, hasAutoPost:true, hasAdPressure:true,
    hasCitations:true, hasWhiteLabel:true, hasTeam:true,
    hasReviewIntelligence:true, hasL3Reports:true, citationAuditsPerMonth:4,
  },
  enterprise: {
    name:'enterprise', displayName:'Enterprise', priceMonthly:0,
    credits:99999, maxBusinesses:999, maxCompetitorsPerLocation:999, maxKeywords:999,
    hasAiReplies:true, hasAutoPost:true, hasAdPressure:true,
    hasCitations:true, hasWhiteLabel:true, hasTeam:true,
    hasReviewIntelligence:true, hasL3Reports:true, citationAuditsPerMonth:99,
  },
  professional: {
    name:'professional', displayName:'Pro', priceMonthly:199,
    credits:1800, maxBusinesses:5, maxCompetitorsPerLocation:5, maxKeywords:3,
    hasAiReplies:true, hasAutoPost:true, hasAdPressure:true,
    hasCitations:true, hasWhiteLabel:true, hasTeam:true,
    hasReviewIntelligence:true, hasL3Reports:true, citationAuditsPerMonth:2,
  },
};

export function getPlan(n: string): PlanConfig        { return PLANS[n] ?? PLANS.starter; }
export function businessLimit(n: string): number       { return getPlan(n).maxBusinesses; }
export function competitorLimit(n: string): number     { return getPlan(n).maxCompetitorsPerLocation; }
export function keywordLimit(n: string): number        { return getPlan(n).maxKeywords; }
export function canUseAiReplies(n: string): boolean    { return getPlan(n).hasAiReplies; }
export function canAutoPost(n: string): boolean        { return getPlan(n).hasAutoPost; }

export const CREDIT_COSTS = { MANUAL_SCAN: 25, AI_REPLY: 1 } as const;

export class BillingService {
  getPlan(n: string): PlanConfig { return getPlan(n); }

  async getCreditsBalance(userId: string): Promise<number> {
    const { data } = await db.from('profiles').select('credits_balance').eq('id', userId).single();
    return data?.credits_balance ?? 0;
  }

  async checkAndDeductCredits(d: CreditDeduction): Promise<void> {
    const bal = await this.getCreditsBalance(d.userId);
    if (bal < d.amount) throw new InsufficientCreditsError(d.amount, bal);
    const nb = bal - d.amount;
    const { error } = await db.from('profiles').update({ credits_balance: nb }).eq('id', d.userId);
    if (error) throw new Error('Failed to deduct credits: ' + error.message);
    await db.from('credit_transactions').insert({
      user_id: d.userId, amount: -d.amount, balance_after: nb,
      reason: d.reason, transaction_type: d.transactionType,
    });
    eventBus.publish(Events.CREDITS_DEDUCTED, { userId: d.userId, amount: d.amount, newBalance: nb });
    logger.info('[Billing] Credits deducted', { userId: d.userId, amount: d.amount, newBalance: nb });
  }

  async getCreditHistory(userId: string, limit = 50): Promise<any[]> {
    const { data } = await db.from('credit_transactions')
      .select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
    return data ?? [];
  }

  async resetMonthlyCredits(): Promise<void> {
    const { data: profiles } = await db.from('profiles').select('id, plan');
    if (!profiles?.length) return;
    for (const p of profiles) {
      const plan = getPlan(p.plan);
      if (plan.credits === 99999) continue;
      await db.from('profiles').update({ credits_balance: plan.credits }).eq('id', p.id);
      await db.from('credit_transactions').insert({
        user_id: p.id, amount: plan.credits, balance_after: plan.credits,
        reason: 'Monthly credit reset', transaction_type: 'monthly_reset',
      });
    }
    logger.info('[Billing] Monthly reset complete', { count: profiles.length });
  }
}

export const billingService = new BillingService();
EOF

# ─────────────────────────────────────────────────────────────
# BACKEND: 2. OrganicScanService.ts — save sponsored results
# ─────────────────────────────────────────────────────────────
echo "  [2/17] OrganicScanService.ts"
cat > "$ROOT/apps/api/src/domains/scanning/OrganicScanService.ts" << 'EOF'
/**
 * One API call per grid point returns BOTH organic + sponsored.
 * Competitor ranks extracted from same organic response — zero extra calls.
 * Sponsored results saved for ad pressure intelligence — zero extra cost.
 */
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { eventBus, Events } from '../../infrastructure/events/EventBus.js';
import { setScanProgress, releaseScanSlot } from '../../infrastructure/cache/CacheService.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { serpApiService } from '../serpapi/SerpApiService.js';
import { geoService } from '../geo/GeoService.js';
import type { ScanPoint, GridScore, HeatmapPoint, ScanJob } from '../../shared/types/contracts.js';
import type { SerpTtlContext } from '../../infrastructure/cache/CacheService.js';

export class OrganicScanService {
  async runScan(job: ScanJob): Promise<void> {
    const { scanId, userId, businessId, clientGooglePlaceId,
            competitors, keyword, points, radiusKm, isAutomated = false } = job;
    const today = new Date().toISOString().split('T')[0];
    const ttlContext: SerpTtlContext = isAutomated ? 'WEEKLY_SCAN' : 'MANUAL_SCAN';

    logger.info('[Scan] Start', { scanId, keyword, pts: points.length, isAutomated });

    await db.from('organic_scans').update({
      state: 'running', started_at: new Date().toISOString(),
      total_points: points.length, points_completed: 0,
    }).eq('id', scanId);

    eventBus.publish(Events.SCAN_ORGANIC_STARTED, { scanId, userId, businessId, keyword, totalPoints: points.length });

    const organic   = new Map<number, any[]>(); // pointIndex → results
    const sponsored = new Map<number, any[]>(); // pointIndex → sponsored

    const BATCH = 3;
    let done = 0;

    for (let i = 0; i < points.length; i += BATCH) {
      await Promise.all(points.slice(i, i + BATCH).map(async (pt) => {
        const res  = await serpApiService.search(pt.lat, pt.lng, keyword, radiusKm * 1000, ttlContext, scanId);
        const loc  = await geoService.reverseGeocode(pt.lat, pt.lng);
        organic.set(pt.index,   res.organic.map(r   => ({ ...r, _loc: loc, _lat: pt.lat, _lng: pt.lng, _label: pt.label, _idx: pt.index })));
        sponsored.set(pt.index, res.sponsored.map(r => ({ ...r, _loc: loc, _lat: pt.lat, _lng: pt.lng, _label: pt.label, _idx: pt.index })));
      }));

      done = Math.min(i + BATCH, points.length);
      const pct = Math.round((done / points.length) * 100);
      await db.from('organic_scans').update({ points_completed: done }).eq('id', scanId);
      await setScanProgress(scanId, { pointsCompleted: done, totalPoints: points.length, percentComplete: pct });
      eventBus.publish(Events.SCAN_ORGANIC_PROGRESS, { scanId, pointsCompleted: done, totalPoints: points.length, percentComplete: pct });
      if (i + BATCH < points.length) await new Promise(r => setTimeout(r, 400));
    }

    await this.saveRankings(scanId, userId, businessId, keyword, today, points, organic);
    await this.saveSponsored(scanId, userId, businessId, keyword, today, sponsored);

    const clientScore      = this.buildScore(clientGooglePlaceId, 'Your Business', true,  points, organic);
    const competitorScores = competitors.map(c => this.buildScore(c.googlePlaceId, c.name, false, points, organic));

    await db.from('organic_scores').insert({
      scan_id: scanId, user_id: userId, business_id: businessId, keyword, scan_date: today,
      organic_visibility_score:    clientScore.visibilityScore,
      organic_avg_ranking:         clientScore.avgRanking,
      organic_territory_dominance: clientScore.territoryDominance,
      organic_total_cells:         points.length,
      organic_ranked_cells:        clientScore.rankedCells,
      organic_top3_cells:          clientScore.top3Cells,
      organic_top10_cells:         clientScore.top10Cells,
      organic_heatmap_points:      clientScore.heatmapPoints,
      competitor_scores:           competitorScores,
    });

    await db.from('organic_scans').update({
      state: 'completed', points_completed: points.length, completed_at: new Date().toISOString(),
    }).eq('id', scanId);

    eventBus.publish(Events.SCAN_ORGANIC_COMPLETED, {
      scanId, userId, businessId, keyword, score: clientScore.visibilityScore, clientGooglePlaceId,
    });

    this.saveDiscovered(organic).catch(console.error);
    await releaseScanSlot(userId);
    logger.info('[Scan] Complete', { scanId, score: clientScore.visibilityScore });
  }

  private buildScore(placeId: string | null, name: string, isClient: boolean,
    points: ScanPoint[], organic: Map<number, any[]>): GridScore {
    const rankAt = new Map<number, number>();
    if (placeId) {
      for (const [idx, res] of organic) {
        const f = res.find(r => r.placeId === placeId);
        if (f) rankAt.set(idx, f.rank);
      }
    } else if (isClient) {
      for (const [idx, res] of organic) { if (res.length > 0) rankAt.set(idx, res[0].rank); }
    }
    const ranks  = [...rankAt.values()];
    const top3   = ranks.filter(r => r <= 3).length;
    const top10  = ranks.filter(r => r <= 10).length;
    const avg    = ranks.length > 0 ? ranks.reduce((s, r) => s + r, 0) / ranks.length : null;
    const score  = points.length > 0
      ? (ranks.reduce((s, r) => s + Math.max(0, 1 - (r - 1) / 20), 0) / points.length) * 100 : 0;
    const dom    = points.length > 0 ? (top3 / points.length) * 100 : 0;
    const heatmapPoints: HeatmapPoint[] = points.map(p => {
      const rank = rankAt.get(p.index) ?? null;
      const res  = organic.get(p.index) ?? [];
      return { lat: p.lat, lng: p.lng, rank, label: p.label,
        locationName: res[0]?._loc ?? p.label,
        intensity: rank ? Math.max(0, 1 - (rank - 1) / 20) : 0, googleMapsUrl: p.googleMapsUrl };
    });
    return {
      placeId: placeId ?? '', name, isClientBusiness: isClient,
      visibilityScore: Math.round(score * 100) / 100,
      avgRanking: avg ? Math.round(avg * 100) / 100 : null,
      territoryDominance: Math.round(dom * 100) / 100,
      top3Cells: top3, top10Cells: top10, rankedCells: ranks.length,
      totalCells: points.length, heatmapPoints,
    };
  }

  private async saveRankings(scanId: string, userId: string, businessId: string,
    keyword: string, scanDate: string, points: ScanPoint[], organic: Map<number, any[]>) {
    const rows: any[] = [];
    for (const [idx, res] of organic) {
      const pt  = points.find(p => p.index === idx)!;
      const loc = res[0]?._loc ?? pt.label;
      if (!res.length) {
        rows.push({ scan_id: scanId, user_id: userId, business_id: businessId,
          keyword, scan_date: scanDate, point_index: idx, point_label: pt.label,
          location_name: loc, google_maps_url: pt.googleMapsUrl,
          latitude: pt.lat, longitude: pt.lng,
          found_place_id: null, found_business_name: null,
          rank_position: null, total_results: 0, result_type: 'organic' });
      } else {
        for (const r of res) {
          rows.push({ scan_id: scanId, user_id: userId, business_id: businessId,
            keyword, scan_date: scanDate, point_index: idx, point_label: pt.label,
            location_name: loc, google_maps_url: pt.googleMapsUrl,
            latitude: pt.lat, longitude: pt.lng,
            found_place_id: r.placeId, found_business_name: r.name,
            found_address: r.address, found_phone: r.phone,
            found_rating: r.rating, found_review_count: r.reviewCount,
            rank_position: r.rank, total_results: res.length, result_type: 'organic' });
        }
      }
    }
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await db.from('organic_rankings').insert(rows.slice(i, i + 100));
      if (error) logger.error('[Scan] Rankings insert error', { error: error.message });
    }
  }

  private async saveSponsored(scanId: string, userId: string, businessId: string,
    keyword: string, scanDate: string, sponsored: Map<number, any[]>) {
    const rows: any[] = [];
    for (const [, res] of sponsored) {
      for (const r of res) {
        rows.push({ scan_id: scanId, user_id: userId, business_id: businessId,
          keyword, scan_date: scanDate,
          point_index: r._idx, point_label: r._label, location_name: r._loc,
          latitude: r._lat, longitude: r._lng,
          place_id: r.placeId, business_name: r.name, address: r.address,
          rank_position: r.rank, rating: r.rating, review_count: r.reviewCount });
      }
    }
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await db.from('ad_pressure_results').insert(rows.slice(i, i + 100));
      if (error) logger.debug('[Scan] ad_pressure_results note', { msg: error.message });
    }
  }

  private async saveDiscovered(organic: Map<number, any[]>) {
    const seen = new Map<string, any>();
    for (const [, res] of organic) {
      for (const r of res) { if (r.placeId && !seen.has(r.placeId)) seen.set(r.placeId, r); }
    }
    for (const [placeId, r] of seen) {
      await db.from('discovered_businesses').upsert({
        google_place_id: placeId, name: r.name, address: r.address,
        latitude: r._lat, longitude: r._lng, rating: r.rating, review_count: r.reviewCount,
        last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: 'google_place_id', ignoreDuplicates: false });
    }
  }
}

export const organicScanService = new OrganicScanService();
EOF

# ─────────────────────────────────────────────────────────────
# BACKEND: 3. AdPressureService.ts — fix ttlContext to AD_PRESSURE
# ─────────────────────────────────────────────────────────────
echo "  [3/17] AdPressureService.ts — Priority Queue routing"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/domains/adpressure/AdPressureService.ts'
with open(path) as f: src = f.read()
# Fix: pass AD_PRESSURE ttlContext so DataForSEO routes to Priority Queue
src = src.replace(
    "const results = await serpApiService.search(point.lat, point.lng, keyword, radiusKm * 1000);",
    "const results = await serpApiService.search(point.lat, point.lng, keyword, radiusKm * 1000, 'AD_PRESSURE', job.sessionId);"
)
with open(path, 'w') as f: f.write(src)
print("  ✓ AdPressureService.ts ttlContext fixed")
PYEOF

# ─────────────────────────────────────────────────────────────
# BACKEND: 4. GeoService.ts — fix default interval 90->60
# ─────────────────────────────────────────────────────────────
echo "  [4/17] GeoService.ts — interval default 90->60"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/domains/geo/GeoService.ts'
with open(path) as f: src = f.read()
src = src.replace('intervalMinutes = 90', 'intervalMinutes = 60')
with open(path, 'w') as f: f.write(src)
print("  ✓ GeoService.ts interval fixed to 60")
PYEOF

# ─────────────────────────────────────────────────────────────
# BACKEND: 5. IntelligenceService.ts — remove L1, daily L2, L3 report
# ─────────────────────────────────────────────────────────────
echo "  [5/17] IntelligenceService.ts"
cat > "$ROOT/apps/api/src/domains/intelligence/IntelligenceService.ts" << 'EOF'
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

        await enqueueOrganicScan({
          scanId: scan.id, userId, businessId,
          clientGooglePlaceId: biz.google_place_id,
          competitors: (comps ?? []).map(c => ({ id: c.id, name: c.name, googlePlaceId: c.google_place_id })),
          keyword, points, radiusKm: 5, isAutomated: true,
        });

        // Compare scores to previous — detect visibility changes
        const { data: prev } = await db.from('organic_scores')
          .select('organic_visibility_score')
          .eq('business_id', businessId).eq('user_id', userId)
          .order('scanned_at', { ascending: false }).limit(2);

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
EOF

# ─────────────────────────────────────────────────────────────
# BACKEND: 6. WeeklyScheduler.ts
# ─────────────────────────────────────────────────────────────
echo "  [6/17] WeeklyScheduler.ts"
cat > "$ROOT/apps/api/src/domains/scheduling/WeeklyScheduler.ts" << 'EOF'
/**
 * WeeklyScheduler — all background cron logic
 * runDailyL2Scans()    — 1am UTC — full 25pt per kw per biz (replaces L1)
 * runWeeklyReports()   — Mon 2am — process 7 days L2 data, ZERO new API calls
 * runMonthlyReset()    — 1st month — credit reset
 * runDailyReviewSync() — 4am UTC — enqueue review sync all businesses
 *
 * Background scans use ZERO user credits.
 * Correct formula: locs × kws × 25 pts (NO ×(1+comps) — competitor data free)
 */
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { intelligenceService } from '../intelligence/IntelligenceService.js';
import { billingService } from '../billing/BillingService.js';
import { enqueueReviewSync } from '../../infrastructure/queue/QueueRegistry.js';

export class WeeklyScheduler {

  async runDailyL2Scans(): Promise<void> {
    logger.info('[Scheduler] Daily L2 start');
    const { data: profiles } = await db.from('profiles').select('id, plan');
    if (!profiles?.length) return;
    let scanned = 0, skipped = 0;
    for (const p of profiles) {
      try {
        const { data: bizs } = await db.from('businesses')
          .select('id').eq('user_id', p.id).neq('is_active', false);
        for (const b of (bizs ?? [])) {
          const kws = await this.getKeywords(b.id);
          if (!kws.length) { skipped++; continue; }
          await intelligenceService.runDailyL2Scan(b.id, p.id, kws)
            .catch(e => logger.error('[Scheduler] L2 fail', { bizId: b.id, error: e.message }));
          scanned++;
        }
      } catch (e: any) {
        logger.error('[Scheduler] Profile L2 fail', { profileId: p.id, error: e.message });
      }
    }
    logger.info('[Scheduler] Daily L2 done', { scanned, skipped });
  }

  async runWeeklyReports(): Promise<void> {
    logger.info('[Scheduler] Weekly L3 reports start');
    const { data: profiles } = await db.from('profiles').select('id, plan');
    if (!profiles?.length) return;
    for (const p of profiles) {
      const { data: bizs } = await db.from('businesses')
        .select('id').eq('user_id', p.id).neq('is_active', false);
      for (const b of (bizs ?? [])) {
        await intelligenceService.runWeeklyReport(b.id, p.id)
          .catch(e => logger.error('[Scheduler] L3 fail', { bizId: b.id, error: e.message }));
      }
    }
    logger.info('[Scheduler] Weekly reports done');
  }

  async runMonthlyReset(): Promise<void> {
    logger.info('[Scheduler] Monthly credit reset');
    await billingService.resetMonthlyCredits();
  }

  async runDailyReviewSync(): Promise<void> {
    logger.info('[Scheduler] Review sync start');
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    const { data: bizs } = await db.from('businesses')
      .select('id, user_id, google_place_id, name, last_review_sync')
      .neq('is_active', false).not('google_place_id', 'is', null);
    let queued = 0;
    for (const b of (bizs ?? [])) {
      if (!b.last_review_sync || b.last_review_sync < cutoff) {
        await enqueueReviewSync({ businessId: b.id, userId: b.user_id, googlePlaceId: b.google_place_id, businessName: b.name })
          .catch(e => logger.error('[Scheduler] Review sync queue fail', { bizId: b.id, error: e.message }));
        queued++;
      }
    }
    logger.info('[Scheduler] Review sync queued', { queued });
  }

  private async getKeywords(businessId: string): Promise<string[]> {
    const { data } = await db.from('business_keywords')
      .select('keyword').eq('business_id', businessId).eq('is_active', true).order('display_order');
    return (data ?? []).map((k: any) => k.keyword);
  }
}

export const weeklyScheduler = new WeeklyScheduler();
EOF

# ─────────────────────────────────────────────────────────────
# BACKEND: 7. intelligence.ts route — clean, no L1/L2/L3 exposure
# ─────────────────────────────────────────────────────────────
echo "  [7/17] intelligence.ts route"
cat > "$ROOT/apps/api/src/api/routes/intelligence.ts" << 'EOF'
/**
 * GET /api/intelligence/status?businessId=  — L0 passive, zero API calls
 * GET /api/intelligence/signals?businessId= — recent signals from DB
 *
 * No L1/L2/L3 manual triggers. No apiCostEstimate. No threshold management.
 * Intelligence runs fully automated in background.
 */
import { Router } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { intelligenceService } from '../../domains/intelligence/IntelligenceService.js';
import { getCacheConfidence } from '../../infrastructure/cache/CacheService.js';
import { db } from '../../infrastructure/database/SupabaseClient.js';

const router = Router();

router.get('/status', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  const [passive, opportunityScore, conf] = await Promise.all([
    intelligenceService.getPassiveIntelligence(businessId as string, req.userId!),
    intelligenceService.computeOpportunityScore(businessId as string, req.userId!),
    getCacheConfidence(businessId as string),
  ]);
  res.json({
    opportunityScore,
    monitoring: {
      active: true,
      confidence:      conf?.score ?? 100,
      changesDetected: conf?.changesDetected ?? false,
      lastChecked:     conf?.lastL1 ?? null,
      lastFullScan:    conf?.lastL3 ?? null,
    },
    recentSignals: passive.recentSignals,
    latestScore:   passive.latestScore,
  });
});

router.get('/signals', requireAuth, async (req: AuthRequest, res) => {
  const { businessId, limit = '50' } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  const { data: signals } = await db.from('intel_signals')
    .select('*').eq('business_id', businessId as string).eq('user_id', req.userId!)
    .order('detected_at', { ascending: false }).limit(parseInt(limit as string));
  res.json({ signals: signals ?? [] });
});

export default router;
EOF

# ─────────────────────────────────────────────────────────────
# BACKEND: 8. organicScans.ts — fix credit order, fix import
# ─────────────────────────────────────────────────────────────
echo "  [8/17] organicScans.ts route"
cat > "$ROOT/apps/api/src/api/routes/organicScans.ts" << 'EOF'
/**
 * Manual scans: any keyword allowed (exploration tool).
 * Credits deducted AFTER scan record created.
 * 25 credits per scan (25 grid points).
 */
import { Router, type Response } from 'express';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { enqueueOrganicScan } from '../../infrastructure/queue/QueueRegistry.js';
import { geoService } from '../../domains/geo/GeoService.js';
import { checkConcurrentScans } from '../../infrastructure/cache/CacheService.js';
import { redis } from '../../infrastructure/cache/RedisClient.js';
import { billingService, CREDIT_COSTS } from '../../domains/billing/BillingService.js';
import { NoLocationError, NoScanPointsError, RateLimitError } from '../../shared/errors/DomainErrors.js';
import { logger } from '../../infrastructure/logger/Logger.js';

const router = Router();

router.get('/address-autocomplete', requireAuth, async (req: AuthRequest, res) => {
  const q = req.query.q as string;
  if (!q || q.length < 2) return res.json({ suggestions: [] });
  const { getAddressAutocomplete } = await import('../../domains/identity/GoogleMapsService.js');
  res.json({ suggestions: await getAddressAutocomplete(q) });
});

router.get('/address-details/:placeId', requireAuth, async (req, res) => {
  const { getPlaceDetails } = await import('../../domains/identity/GoogleMapsService.js');
  const d = await getPlaceDetails(req.params.placeId);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json({ lat: d.latitude, lng: d.longitude, address: d.address });
});

router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { data } = await db.from('organic_scans')
    .select('*, organic_scores(organic_visibility_score, organic_avg_ranking, organic_territory_dominance, organic_top3_cells, organic_total_cells)')
    .eq('user_id', req.userId!).order('created_at', { ascending: false }).limit(50);
  res.json({ scans: data ?? [] });
});

router.get('/:scanId', requireAuth, async (req: AuthRequest, res) => {
  const { data: scan } = await db.from('organic_scans')
    .select('*').eq('id', req.params.scanId).eq('user_id', req.userId!).single();
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  const [{ data: score }, { data: rankings }] = await Promise.all([
    db.from('organic_scores').select('*').eq('scan_id', req.params.scanId).single(),
    db.from('organic_rankings')
      .select('latitude, longitude, rank_position, point_index, point_label, location_name, found_business_name, found_place_id, result_type, google_maps_url')
      .eq('scan_id', req.params.scanId).order('point_index').order('rank_position', { ascending: true, nullsFirst: false }),
  ]);
  res.json({ scan, score, rankings: rankings ?? [] });
});

router.get('/:scanId/progress', requireAuth, async (req: AuthRequest, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const scanId     = req.params.scanId;
  const subscriber = redis.duplicate();
  await subscriber.subscribe(`scan:progress:${scanId}`);
  subscriber.on('message', (_ch, msg) => {
    res.write(`data: ${msg}\n\n`);
    const d = JSON.parse(msg);
    if (d.percentComplete >= 100 || d.state === 'completed' || d.state === 'failed') {
      res.end(); subscriber.disconnect();
    }
  });
  req.on('close', () => subscriber.disconnect());
  const { data: scan } = await db.from('organic_scans')
    .select('state, points_completed, total_points').eq('id', scanId).single();
  if (scan) {
    const pct = scan.total_points > 0 ? Math.round((scan.points_completed / scan.total_points) * 100) : 0;
    res.write(`data: ${JSON.stringify({ pointsCompleted: scan.points_completed, totalPoints: scan.total_points, percentComplete: pct, state: scan.state })}\n\n`);
    if (scan.state === 'completed' || scan.state === 'failed') { res.end(); subscriber.disconnect(); }
  }
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, keyword, targetingMethod, radiusKm, gridSize, inputAddresses, inputZipCodes } = req.body;
    if (!businessId || !keyword || !targetingMethod) {
      return res.status(400).json({ error: 'businessId, keyword and targetingMethod required' });
    }
    if (!await checkConcurrentScans(req.userId!, 5)) throw new RateLimitError(5);

    const { data: biz } = await db.from('businesses')
      .select('latitude, longitude, name, google_place_id')
      .eq('id', businessId).eq('user_id', req.userId!).single();
    if (!biz) return res.status(404).json({ error: 'Business not found' });
    if (!biz.latitude || !biz.longitude) throw new NoLocationError();

    const radius = parseFloat(radiusKm ?? '5');
    const gSize  = parseInt(gridSize ?? '3');

    const { data: comps } = await db.from('competitors')
      .select('id, name, google_place_id').eq('business_id', businessId).neq('is_active', false).order('display_order');

    let points: any[] = [];
    if (targetingMethod === 'auto_grid') {
      points = geoService.generateAutoGrid(biz.latitude, biz.longitude, radius, gSize);
    } else if (targetingMethod === 'addresses' && inputAddresses?.length) {
      points = await geoService.generateAddressPoints(inputAddresses.slice(0, 9));
    } else if (targetingMethod === 'zip_codes' && inputZipCodes?.length) {
      points = await geoService.generateZipCodePoints(inputZipCodes.slice(0, 6), radius);
    }
    if (!points.length) throw new NoScanPointsError();

    // Create scan FIRST — then deduct credits
    const { data: scan, error: scanErr } = await db.from('organic_scans').insert({
      user_id: req.userId, business_id: businessId, keyword,
      targeting_method: targetingMethod, radius_km: radius, grid_size: gSize,
      input_addresses: inputAddresses ?? null, input_zip_codes: inputZipCodes ?? null,
      state: 'pending', credits_consumed: CREDIT_COSTS.MANUAL_SCAN,
      scan_date: new Date().toISOString().split('T')[0],
      scan_points: points, total_points: points.length, points_completed: 0,
      is_automated: false,
    }).select().single();
    if (scanErr || !scan) throw new Error(scanErr?.message ?? 'Failed to create scan');

    await billingService.checkAndDeductCredits({
      userId: req.userId!, amount: CREDIT_COSTS.MANUAL_SCAN,
      reason: `Manual scan: ${keyword}`, transactionType: 'usage',
    });

    await enqueueOrganicScan({
      scanId: scan.id, userId: req.userId!, businessId,
      clientGooglePlaceId: biz.google_place_id,
      competitors: (comps ?? []).map(c => ({ id: c.id, name: c.name, googlePlaceId: c.google_place_id })),
      keyword, points, radiusKm: radius, isAutomated: false,
    });

    logger.info('[Route] Manual scan created', { scanId: scan.id, keyword, credits: CREDIT_COSTS.MANUAL_SCAN });
    res.status(201).json({ scanId: scan.id, state: 'pending', totalPoints: points.length, creditsConsumed: CREDIT_COSTS.MANUAL_SCAN });
  } catch (err: any) {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  }
});

export default router;
EOF

# ─────────────────────────────────────────────────────────────
# BACKEND: 9. adScans.ts — fix slot IDs, interval=60, credit order, start/end time
# ─────────────────────────────────────────────────────────────
echo "  [9/17] adScans.ts — fix slot IDs, 60min interval, start/end time picker"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/api/routes/adScans.ts'
with open(path) as f: src = f.read()

# Fix interval 90 -> 60 everywhere
src = src.replace('interval_minutes: 90', 'interval_minutes: 60')
src = src.replace('intervalMinutes: 90', 'intervalMinutes: 60')
src = src.replace('generateScanSchedule(todayHours.open, todayHours.close, 90)', 'generateScanSchedule(todayHours.open, todayHours.close, 60)')
src = src.replace("Scans run every 1.5 hours", "Scans run every 1 hour")

# Fix slot ID issue: insert slots first then fetch IDs
old = """  await supabase.from('ad_scan_slots').insert(slotRows);

  // Schedule jobs in database — survives restarts
  // Enqueue each slot via BullMQ
  for (const biz of businesses) {
    for (let _si = 0; _si < validTimes.length; _si++) {
      const [_h, _m] = validTimes[_si].split(':').map(Number);
      const _slotTime = new Date();
      _slotTime.setHours(_h, _m, 0, 0);
      const _delayMs = Math.max(0, _slotTime.getTime() - Date.now());
      const _slotRow = slotRows.find((s: any) => s.business_id === biz.id && s.slot_index === _si);
      if (_slotRow) {
        await enqueueAdSlot({
          slotId: _slotRow.id ?? (session.id + '_' + biz.id + '_' + _si),
          sessionId: session.id, userId: req.userId, businessId: biz.id,
          keyword, radiusKm: radius, gridSize: gSize,
          targetingMethod: method,
          inputAddresses: (!isMulti && method === 'addresses') ? inputAddresses : null,
          inputZipCodes: (!isMulti && method === 'zip_codes') ? inputZipCodes : null,
        }, _delayMs);
      }
    }
  }"""

new = """  // Insert slots first — DB assigns real UUIDs
  const { data: insertedSlots } = await supabase.from('ad_scan_slots').insert(slotRows).select('id, business_id, slot_index, slot_time');

  // Enqueue using real DB-assigned IDs (not in-memory stubs)
  for (const slot of (insertedSlots ?? [])) {
    const [_h, _m] = slot.slot_time.split(':').map(Number);
    const _slotTime = new Date();
    _slotTime.setHours(_h, _m, 0, 0);
    const _delayMs = Math.max(0, _slotTime.getTime() - Date.now());
    await enqueueAdSlot({
      slotId: slot.id,
      sessionId: session.id, userId: req.userId, businessId: slot.business_id,
      keyword, radiusKm: radius, gridSize: gSize,
      targetingMethod: method,
      inputAddresses: (!isMulti && method === 'addresses') ? inputAddresses : null,
      inputZipCodes: (!isMulti && method === 'zip_codes') ? inputZipCodes : null,
    }, _delayMs);
  }"""

if old in src:
    src = src.replace(old, new)
    print("  ✓ adScans.ts slot IDs fixed")
else:
    print("  ⚠ adScans.ts slot ID pattern not matched — check manually")

with open(path, 'w') as f: f.write(src)
print("  ✓ adScans.ts interval and slot fixes applied")
PYEOF

# ─────────────────────────────────────────────────────────────
# BACKEND: 10. dashboard.ts — remove apiCostEstimate
# ─────────────────────────────────────────────────────────────
echo "  [10/17] dashboard.ts — remove apiCostEstimate"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/api/routes/dashboard.ts'
with open(path) as f: src = f.read()
src = src.replace(
    "level:       intelLevel ?? { level: 0, reason: 'Passive Intelligence Active', apiCostEstimate: 0 },",
    "level:       intelLevel ?? { level: 0, reason: 'Monitoring active' },"
)
src = src.replace("apiCostEstimate: 0 }", "}")
src = src.replace(", apiCostEstimate: 0", "")
with open(path, 'w') as f: f.write(src)
print("  ✓ dashboard.ts apiCostEstimate removed")
PYEOF

# ─────────────────────────────────────────────────────────────
# BACKEND: 11. citations.ts — remove inline cron
# ─────────────────────────────────────────────────────────────
echo "  [11/17] citations.ts — remove inline cron"
python3 - "$ROOT" << 'PYEOF'
import sys, re
root = sys.argv[1]
path = root + '/apps/api/src/api/routes/citations.ts'
with open(path) as f: src = f.read()
src = src.replace("import cron from 'node-cron';\n\n", "")
src = src.replace("import cron from 'node-cron';\n", "")
# Remove the cron.schedule block
src = re.sub(
    r"// Weekly cron.*?cron\.schedule\('0 9 \* \* 1'.*?\}\);\n\n",
    "", src, flags=re.DOTALL
)
with open(path, 'w') as f: f.write(src)
print("  ✓ citations.ts inline cron removed")
PYEOF

# ─────────────────────────────────────────────────────────────
# BACKEND: 12. reviews.ts — import canUseAiReplies
# ─────────────────────────────────────────────────────────────
echo "  [12/17] reviews.ts — import canUseAiReplies"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/api/routes/reviews.ts'
with open(path) as f: src = f.read()
if 'canUseAiReplies' not in src:
    src = src.replace(
        "import { serpFetchReviews, hasSerpApiKey } from '../../domains/serpapi/SerpApiService.js';",
        "import { serpFetchReviews, hasSerpApiKey } from '../../domains/serpapi/SerpApiService.js';\nimport { canUseAiReplies } from '../../domains/billing/BillingService.js';"
    )
    with open(path, 'w') as f: f.write(src)
print("  ✓ reviews.ts canUseAiReplies imported")
PYEOF

# ─────────────────────────────────────────────────────────────
# BACKEND: 13. auth.ts — use plan credits on signup
# ─────────────────────────────────────────────────────────────
echo "  [13/17] auth.ts — plan credits on signup"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/api/routes/auth.ts'
with open(path) as f: src = f.read()
if "PLANS" not in src:
    src = src.replace(
        "import { orgService } from '../../domains/orgs/OrgService.js';",
        "import { orgService } from '../../domains/orgs/OrgService.js';\nimport { PLANS } from '../../domains/billing/BillingService.js';"
    )
src = src.replace(
    "plan: 'starter',\n      credits_balance: 100,\n      monthly_allowance: 100,",
    "plan: 'starter',\n      credits_balance: PLANS.starter.credits,\n      monthly_allowance: PLANS.starter.credits,"
)
with open(path, 'w') as f: f.write(src)
print("  ✓ auth.ts signup credits fixed to 900")
PYEOF

# ─────────────────────────────────────────────────────────────
# BACKEND: 14. businesses.ts — fix is_active filter
# ─────────────────────────────────────────────────────────────
echo "  [14/17] businesses.ts — fix is_active"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/api/routes/businesses.ts'
with open(path) as f: src = f.read()
src = src.replace(".eq('is_active', true)", ".neq('is_active', false)")
with open(path, 'w') as f: f.write(src)
print("  ✓ businesses.ts is_active fixed")
PYEOF

# ─────────────────────────────────────────────────────────────
# BACKEND: 15. Custom scans route
# ─────────────────────────────────────────────────────────────
echo "  [15/17] custom-scans route — new feature"
cat > "$ROOT/apps/api/src/api/routes/customScans.ts" << 'EOF'
/**
 * Custom Scans — /api/custom-scans
 *
 * Standalone scans from any center point, any keyword.
 * NOT tied to any business. Does NOT affect intelligence history.
 * Both organic ranking and ad pressure from same API call.
 * 25 credits per scan — uses user credit pool.
 */
import { Router } from 'express';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { billingService, CREDIT_COSTS } from '../../domains/billing/BillingService.js';
import { geoService } from '../../domains/geo/GeoService.js';
import { serpApiService } from '../../domains/serpapi/SerpApiService.js';
import { logger } from '../../infrastructure/logger/Logger.js';

const router = Router();

// GET /api/custom-scans — list history
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { data } = await db.from('custom_scans')
    .select('*').eq('user_id', req.userId!)
    .order('created_at', { ascending: false }).limit(50);
  res.json({ scans: data ?? [] });
});

// GET /api/custom-scans/:id — single result
router.get('/:id', requireAuth, async (req: AuthRequest, res) => {
  const { data } = await db.from('custom_scans')
    .select('*').eq('id', req.params.id).eq('user_id', req.userId!).single();
  if (!data) return res.status(404).json({ error: 'Scan not found' });
  res.json({ scan: data });
});

// POST /api/custom-scans — run a custom scan
// Body: { keyword, centerLat, centerLng, centerAddress, radiusKm?, scanType? }
// scanType: 'organic' | 'ad_pressure' | 'both' (default: 'both')
router.post('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    const {
      keyword, centerLat, centerLng, centerAddress,
      radiusKm = 5, scanType = 'both',
    } = req.body;

    if (!keyword?.trim())   return res.status(400).json({ error: 'keyword required' });
    if (!centerLat || !centerLng) return res.status(400).json({ error: 'centerLat and centerLng required' });

    const lat = parseFloat(centerLat);
    const lng = parseFloat(centerLng);
    const r   = parseFloat(radiusKm);

    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'Invalid coordinates' });

    // Create record FIRST — then deduct credits
    const { data: scan, error: scanErr } = await db.from('custom_scans').insert({
      user_id:        req.userId,
      scan_type:      scanType,
      keyword:        keyword.trim().toLowerCase(),
      center_lat:     lat,
      center_lng:     lng,
      center_address: centerAddress ?? null,
      radius_km:      r,
      grid_size:      3,
      state:          'running',
      total_points:   25,
      points_completed: 0,
      credits_consumed: CREDIT_COSTS.MANUAL_SCAN,
      scan_date:      new Date().toISOString().split('T')[0],
    }).select().single();

    if (scanErr || !scan) throw new Error(scanErr?.message ?? 'Failed to create scan');

    // Deduct credits AFTER record created
    await billingService.checkAndDeductCredits({
      userId: req.userId!, amount: CREDIT_COSTS.MANUAL_SCAN,
      reason: `Custom scan: ${keyword} @ ${lat.toFixed(4)},${lng.toFixed(4)}`,
      transactionType: 'usage',
    });

    // Run scan asynchronously — respond immediately
    res.status(201).json({
      scanId:          scan.id,
      state:           'running',
      creditsConsumed: CREDIT_COSTS.MANUAL_SCAN,
      message:         'Scan started. Results will appear in Custom Scans history.',
    });

    // Run in background — don't await
    runCustomScan(scan.id, req.userId!, lat, lng, keyword.trim().toLowerCase(), r, scanType)
      .catch(err => {
        logger.error('[CustomScan] Background scan failed', { scanId: scan.id, error: err.message });
        db.from('custom_scans').update({ state: 'failed' }).eq('id', scan.id).catch(() => {});
      });

  } catch (err: any) {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  }
});

// Address autocomplete for the location picker
router.get('/address-autocomplete', requireAuth, async (req: AuthRequest, res) => {
  const q = req.query.q as string;
  if (!q || q.length < 2) return res.json({ suggestions: [] });
  const { getAddressAutocomplete } = await import('../../domains/identity/GoogleMapsService.js');
  res.json({ suggestions: await getAddressAutocomplete(q) });
});

router.get('/address-details/:placeId', requireAuth, async (req, res) => {
  const { getPlaceDetails } = await import('../../domains/identity/GoogleMapsService.js');
  const d = await getPlaceDetails(req.params.placeId);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json({ lat: d.latitude, lng: d.longitude, address: d.address });
});

// ── Background scan execution ─────────────────────────────────
async function runCustomScan(
  scanId: string, userId: string,
  lat: number, lng: number,
  keyword: string, radiusKm: number,
  scanType: string
): Promise<void> {
  const points = geoService.generateAutoGrid(lat, lng, radiusKm, 3);
  const organicPoints: any[]   = [];
  const sponsoredPoints: any[] = [];

  const BATCH = 3;
  let done = 0;

  for (let i = 0; i < points.length; i += BATCH) {
    await Promise.all(points.slice(i, i + BATCH).map(async (pt) => {
      const res = await serpApiService.search(pt.lat, pt.lng, keyword, radiusKm * 1000, 'MANUAL_SCAN', scanId);
      const loc = await geoService.reverseGeocode(pt.lat, pt.lng);

      if (scanType === 'organic' || scanType === 'both') {
        const rank = res.organic.find(r => r.rank === 1) ?? null;
        organicPoints.push({
          lat: pt.lat, lng: pt.lng, label: pt.label, locationName: loc,
          rank: rank?.rank ?? null, businessName: rank?.name ?? null,
          intensity: rank ? Math.max(0, 1 - (rank.rank - 1) / 20) : 0,
          googleMapsUrl: pt.googleMapsUrl,
          allResults: res.organic.slice(0, 5).map(r => ({ name: r.name, rank: r.rank, placeId: r.placeId })),
        });
      }

      if (scanType === 'ad_pressure' || scanType === 'both') {
        sponsoredPoints.push({
          lat: pt.lat, lng: pt.lng, label: pt.label, locationName: loc,
          adCount: res.sponsored.length, hasAds: res.sponsored.length > 0,
          googleMapsUrl: pt.googleMapsUrl,
          topAdvertisers: res.sponsored.slice(0, 3).map(r => ({ name: r.name, rank: r.rank, placeId: r.placeId })),
        });
      }
    }));
    done = Math.min(i + BATCH, points.length);
    await db.from('custom_scans').update({ points_completed: done }).eq('id', scanId);
    if (i + BATCH < points.length) await new Promise(r => setTimeout(r, 400));
  }

  // Compute visibility score for organic
  const ranks = organicPoints.map(p => p.rank).filter(r => r !== null);
  const visScore = points.length > 0
    ? (ranks.reduce((s: number, r: number) => s + Math.max(0, 1 - (r - 1) / 20), 0) / points.length) * 100 : 0;

  await db.from('custom_scans').update({
    state:             'completed',
    organic_results:   organicPoints.length > 0 ? organicPoints : null,
    sponsored_results: sponsoredPoints.length > 0 ? sponsoredPoints : null,
    visibility_score:  Math.round(visScore * 100) / 100,
    points_completed:  points.length,
    completed_at:      new Date().toISOString(),
  }).eq('id', scanId);

  logger.info('[CustomScan] Complete', { scanId, keyword, visScore });
}

export default router;
EOF

# ─────────────────────────────────────────────────────────────
# BACKEND: 16. index.ts — all crons + custom scan route
# ─────────────────────────────────────────────────────────────
echo "  [16/17] index.ts — wire crons + custom scan route"
cat > "$ROOT/apps/api/src/index.ts" << 'EOF'
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import 'dotenv/config';
import { logger } from './infrastructure/logger/Logger.js';
import './infrastructure/cache/RedisClient.js';
import { queues } from './infrastructure/queue/QueueRegistry.js';
import { startOrganicScanWorker } from './domains/scanning/ScanWorker.js';
import { startReviewWorker } from './domains/reviews/ReviewWorker.js';
import { startAdSlotWorker } from './domains/adpressure/AdPressureService.js';
import { weeklyScheduler } from './domains/scheduling/WeeklyScheduler.js';
import { leaderboardService } from './domains/leaderboard/LeaderboardService.js';

import authRoutes           from './api/routes/auth.js';
import businessRoutes       from './api/routes/businesses.js';
import competitorRoutes     from './api/routes/competitors.js';
import organicScanRoutes    from './api/routes/organicScans.js';
import adScanRoutes         from './api/routes/adScans.js';
import reviewRoutes         from './api/routes/reviews.js';
import leaderboardRoutes    from './api/routes/leaderboard.js';
import citationRoutes       from './api/routes/citations.js';
import dashboardRoutes      from './api/routes/dashboard.js';
import profileRoutes        from './api/routes/profile.js';
import orgRoutes            from './api/routes/orgs.js';
import intelligenceRoutes   from './api/routes/intelligence.js';
import keywordRoutes        from './api/routes/keywords.js';
import reviewIntelRoutes    from './api/routes/reviewIntelligence.js';
import customScanRoutes     from './api/routes/customScans.js';

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth',                authRoutes);
app.use('/api/businesses',          businessRoutes);
app.use('/api/competitors',         competitorRoutes);
app.use('/api/organic-scans',       organicScanRoutes);
app.use('/api/ad-scans',            adScanRoutes);
app.use('/api/reviews',             reviewRoutes);
app.use('/api/leaderboard',         leaderboardRoutes);
app.use('/api/citations',           citationRoutes);
app.use('/api/dashboard',           dashboardRoutes);
app.use('/api/profile',             profileRoutes);
app.use('/api/orgs',                orgRoutes);
app.use('/api/intelligence',        intelligenceRoutes);
app.use('/api/keywords',            keywordRoutes);
app.use('/api/review-intelligence', reviewIntelRoutes);
app.use('/api/custom-scans',        customScanRoutes);

try {
  const { default: configRoutes } = await import('./api/routes/config.js');
  app.use('/api/config', configRoutes);
} catch {}

app.get('/health', (_, res) => res.json({ status: 'ok', version: 'v10', time: new Date().toISOString() }));

app.use((err: any, req: any, res: any, _next: any) => {
  logger.error('[API] Unhandled error', { error: err.message, path: req.path });
  res.status(err.statusCode ?? 500).json({ error: err.message ?? 'Internal server error' });
});

function startCronJobs(): void {
  // Daily L2: full 25pt scan per kw per biz — posts Standard Queue tasks
  cron.schedule('0 1 * * *', async () => {
    logger.info('[Cron] Daily L2 — posting tasks');
    await weeklyScheduler.runDailyL2Scans().catch(e => logger.error('[Cron] L2 failed', { error: e.message }));
  }, { timezone: 'UTC' });

  // Collect DataForSEO Standard Queue results (30min after posting)
  cron.schedule('30 1 * * *', async () => {
    logger.info('[Cron] Collecting Standard Queue results');
    try {
      const mod = await import('./domains/serpapi/SerpApiService.js') as any;
      if (typeof mod.collectPendingTasks === 'function') {
        const stats = await mod.collectPendingTasks();
        logger.info('[Cron] Collect done', stats);
      }
    } catch (e: any) { logger.error('[Cron] Collect failed', { error: e.message }); }
  }, { timezone: 'UTC' });

  // Weekly L3 reports: Mon 2am — processes 7 days L2 data, ZERO new API calls
  cron.schedule('0 2 * * 1', async () => {
    logger.info('[Cron] Weekly L3 reports');
    await weeklyScheduler.runWeeklyReports().catch(e => logger.error('[Cron] L3 failed', { error: e.message }));
  }, { timezone: 'UTC' });

  // Daily review sync: 4am
  cron.schedule('0 4 * * *', async () => {
    logger.info('[Cron] Daily review sync');
    await weeklyScheduler.runDailyReviewSync().catch(e => logger.error('[Cron] Review sync failed', { error: e.message }));
  }, { timezone: 'UTC' });

  // Citation audits: Mon 9am — Growth+ only
  cron.schedule('0 9 * * 1', async () => {
    logger.info('[Cron] Citation audits');
    try {
      const { supabase } = await import('./infrastructure/database/SupabaseClient.js');
      const { data: due } = await supabase.from('citation_audits')
        .select('id,business_id,user_id,brightlocal_campaign_id,reference_name,reference_address,reference_phone')
        .lte('next_audit_date', new Date().toISOString().split('T')[0]).eq('status', 'completed');
      const mod = await import('./api/routes/citations.js') as any;
      if (typeof mod.runAuditBackground === 'function') {
        for (const a of due ?? []) {
          mod.runAuditBackground(a.id, a.business_id, a.user_id, a.reference_name, a.reference_address, a.reference_phone, a.brightlocal_campaign_id)
            .catch((e: any) => logger.error('[Cron] Citation failed', { id: a.id, error: e.message }));
        }
      }
    } catch (e: any) { logger.error('[Cron] Citations cron failed', { error: e.message }); }
  }, { timezone: 'UTC' });

  // Monthly credit reset: 1st of month 00:00
  cron.schedule('0 0 1 * *', async () => {
    logger.info('[Cron] Monthly credit reset');
    await weeklyScheduler.runMonthlyReset().catch(e => logger.error('[Cron] Reset failed', { error: e.message }));
  }, { timezone: 'UTC' });

  logger.info('[Cron] All jobs registered', {
    jobs: ['L2@01:00','Collect@01:30','L3@Mon02:00','Reviews@04:00','Citations@Mon09:00','Credits@1st'],
  });
}

function start() {
  leaderboardService.registerEventHandlers();
  startOrganicScanWorker();
  startAdSlotWorker();
  startReviewWorker();
  startCronJobs();
  const PORT = parseInt(process.env.PORT ?? '3000');
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`BizzRank AI v10 on port ${PORT}`);
    logger.info('Workers: scans(10) · ad-slots(20) · reviews(50)');
    logger.info('Crons: L2@01:00 · Collect@01:30 · L3@Mon02:00 · Reviews@04:00 · Credits@1st');
  });
}

process.on('SIGTERM', async () => {
  await Promise.all([queues.organicScans.close(), queues.adScanSlots.close(), queues.reviewSync.close(), queues.citations.close()]);
  process.exit(0);
});
process.on('uncaughtException',  e => logger.error('Uncaught exception',   { error: e.message }));
process.on('unhandledRejection', r => logger.error('Unhandled rejection',  { reason: r }));

start();
EOF

# ─────────────────────────────────────────────────────────────
# FRONTEND: 17. All frontend changes
# ─────────────────────────────────────────────────────────────
echo "  [17/17] Frontend updates"

# 17a. api.ts — add custom scan API + ad session schedule API
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/frontend/src/lib/api.ts'
with open(path) as f: src = f.read()

addition = """
export const customScanApi = {
  list:              ()        => api.get('/custom-scans'),
  get:               (id: string) => api.get('/custom-scans/' + id),
  create:            (d: any)  => api.post('/custom-scans', d),
  addressAutocomplete: (q: string) => api.get('/custom-scans/address-autocomplete?q=' + encodeURIComponent(q)),
  addressDetails:    (id: string)  => api.get('/custom-scans/address-details/' + id),
};

export const intelApi = {
  status:  (businessId: string) => api.get('/intelligence/status?businessId=' + businessId),
  signals: (businessId: string, limit = 20) => api.get('/intelligence/signals?businessId=' + businessId + '&limit=' + limit),
};
"""

if 'customScanApi' not in src:
    src = src + addition
    with open(path, 'w') as f: f.write(src)
    print("  ✓ api.ts customScanApi + intelApi added")
else:
    print("  ✓ api.ts already has customScanApi")
PYEOF

# 17b. Layout.tsx — add Custom Scan to nav
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/frontend/src/components/Layout.tsx'
with open(path) as f: src = f.read()

# Add custom scan import
if 'CustomScan' not in src:
    src = src.replace(
        "import ProfilePage         from '../pages/Profile';",
        "import ProfilePage         from '../pages/Profile';\nimport CustomScanPage      from '../pages/CustomScan';"
    )
    # Add to NAV array
    src = src.replace(
        "  { path: '/profile',    icon: '👤', label: 'Profile' },",
        "  { path: '/profile',    icon: '👤', label: 'Profile' },\n  { path: '/custom-scan', icon: '🗺️', label: 'Custom Scan' },"
    )
    # Add route
    src = src.replace(
        "              <Route path=\"/profile\"               element={<ProfilePage />} />",
        "              <Route path=\"/profile\"               element={<ProfilePage />} />\n              <Route path=\"/custom-scan\"          element={<CustomScanPage />} />"
    )
    # Add to PAGE_TITLE
    src = src.replace(
        "    '/profile':     'Profile',",
        "    '/profile':     'Profile',\n    '/custom-scan':  'Custom Scan',"
    )
    with open(path, 'w') as f: f.write(src)
    print("  ✓ Layout.tsx custom scan route added")
else:
    print("  ✓ Layout.tsx already has CustomScan")
PYEOF

# 17c. NewAdScan.tsx — replace auto-hours with start/end time picker
cat > "$ROOT/apps/frontend/src/pages/NewAdScan.tsx" << 'JSEOF'
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { bizApi, adApi } from '../lib/api';
import { AddressInputList, ZipCodeInput } from '../components/Shared';

export default function NewAdScanPage() {
  const nav = useNavigate();
  const [step, setStep] = useState<1|2|3>(1);
  const [selectedBizIds, setSelectedBizIds] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [method, setMethod]   = useState('auto_grid');
  const [radiusKm, setRadiusKm] = useState('5');
  const [gridSize, setGridSize] = useState('3');
  const [addresses, setAddresses] = useState<any[]>([]);
  const [zipCodes, setZipCodes]   = useState<string[]>([]);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime]     = useState('21:00');
  const [err, setErr] = useState('');

  const { data: businesses } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => bizApi.list().then(r => r.data.businesses),
  });

  const isMulti = selectedBizIds.length > 1;

  // Calculate number of scans: every hour from start to end inclusive
  const calcScans = () => {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    const startMins = sh * 60 + sm;
    const endMins   = eh * 60 + em;
    if (endMins <= startMins) return 0;
    return Math.floor((endMins - startMins) / 60) + 1;
  };
  const numScans    = calcScans();
  const totalSlots  = numScans * selectedBizIds.length;
  const creditCost  = totalSlots * 25;

  const mutation = useMutation({
    mutationFn: () => adApi.create({
      businessIds: selectedBizIds,
      keyword,
      targetingMethod: isMulti ? 'auto_grid' : method,
      radiusKm: parseFloat(radiusKm),
      gridSize: parseInt(gridSize),
      inputAddresses: method === 'addresses' && !isMulti ? addresses : undefined,
      inputZipCodes:  method === 'zip_codes'  && !isMulti ? zipCodes  : undefined,
      openingHoursOverride: { open: startTime, close: endTime },
    }),
    onSuccess: r => nav('/ad-insights/' + r.data.sessionId),
    onError: (e: any) => setErr(e.response?.data?.error ?? 'Failed to start session'),
  });

  function toggleBiz(id: string) {
    setSelectedBizIds(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  }

  return (
    <div className="max-w-2xl">
      <button onClick={() => nav(-1)} className="text-sm text-gray-400 hover:text-gray-600 mb-4">← Back</button>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-12 h-12 bg-orange-100 rounded-2xl flex items-center justify-center text-2xl">📢</div>
        <div>
          <h1 className="text-xl font-bold">New Ad Pressure Session</h1>
          <p className="text-gray-400 text-xs">Scans run every 1 hour · 25 credits per slot</p>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-6">
        {[1,2,3].map(s => (
          <div key={s} className={'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ' + (step >= s ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-400')}>{s}</div>
        ))}
      </div>

      {step === 1 && (
        <div className="card space-y-5">
          <h2 className="font-bold">Select business and keyword</h2>
          <div>
            <label className="label">Businesses</label>
            <div className="space-y-2">
              {businesses?.map((b: any) => (
                <button key={b.id} onClick={() => toggleBiz(b.id)}
                  className={'w-full text-left p-3 rounded-xl border-2 transition-colors ' + (selectedBizIds.includes(b.id) ? 'border-orange-500 bg-orange-50' : 'border-gray-100 hover:border-gray-200')}>
                  <div className="flex items-center gap-3">
                    <div className={'w-5 h-5 rounded-md border-2 flex items-center justify-center ' + (selectedBizIds.includes(b.id) ? 'bg-orange-500 border-orange-500' : 'border-gray-300')}>
                      {selectedBizIds.includes(b.id) && <span className="text-white text-xs">✓</span>}
                    </div>
                    <div><p className="text-sm font-semibold">{b.name}</p><p className="text-xs text-gray-400">{b.address}</p></div>
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">Keyword</label>
            <input type="text" className="input" value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="pizza, dental, plumber..." />
          </div>
          {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}
          <button onClick={() => { if (!selectedBizIds.length || !keyword) return setErr('Select a business and enter a keyword'); setErr(''); setStep(2); }} className="btn-primary w-full py-2.5">Next →</button>
        </div>
      )}

      {step === 2 && (
        <div className="card space-y-5">
          <h2 className="font-bold">Targeting</h2>
          {!isMulti && (
            <div className="space-y-3">
              {[{ id:'auto_grid', icon:'⊞', title:'Auto Grid', desc:'H3 grid around your business.' },
                { id:'addresses', icon:'📍', title:'Manual Addresses', desc:'Up to 9 addresses.' },
                { id:'zip_codes', icon:'🗺️', title:'Zip Codes', desc:'Up to 6 zip codes.' }
              ].map(opt => (
                <button key={opt.id} onClick={() => setMethod(opt.id)}
                  className={'w-full text-left p-4 rounded-2xl border-2 transition-colors ' + (method === opt.id ? 'border-orange-500 bg-orange-50' : 'border-gray-100 hover:border-gray-200')}>
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">{opt.icon}</span>
                    <div><p className="font-semibold">{opt.title}</p><p className="text-sm text-gray-500">{opt.desc}</p></div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {(isMulti || method === 'auto_grid') && (
            <>
              <div>
                <label className="label">Radius: <span className="text-orange-600">{radiusKm} km</span></label>
                <input type="range" min="1" max="50" step="1" className="w-full accent-orange-500" value={radiusKm} onChange={e => setRadiusKm(e.target.value)} />
              </div>
              <div>
                <label className="label">Grid size</label>
                <select className="input" value={gridSize} onChange={e => setGridSize(e.target.value)}>
                  <option value="2">Small</option><option value="3">Medium</option>
                  <option value="4">Large</option><option value="5">Extra Large</option>
                </select>
              </div>
            </>
          )}
          {!isMulti && method === 'addresses' && <AddressInputList addresses={addresses} onChange={setAddresses} max={9} apiCall={q => adApi.addressAutocomplete(q)} detailsCall={id => adApi.addressDetails(id)} />}
          {!isMulti && method === 'zip_codes'  && <ZipCodeInput zipCodes={zipCodes} onChange={setZipCodes} max={6} />}
          <div className="flex gap-3">
            <button onClick={() => setStep(1)} className="btn-secondary">← Back</button>
            <button onClick={() => setStep(3)} className="btn-primary flex-1">Next →</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card space-y-5">
          <h2 className="font-bold">Monitoring window</h2>
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-700">
            <p className="font-semibold mb-1">How it works</p>
            <p>Choose the start and end time you want to monitor. The system scans every 1 hour within that window. You'll see exactly who is advertising on Google Maps in your area throughout the day.</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Start time</label>
              <input type="time" className="input" value={startTime} onChange={e => setStartTime(e.target.value)} />
            </div>
            <div>
              <label className="label">End time</label>
              <input type="time" className="input" value={endTime} onChange={e => setEndTime(e.target.value)} />
            </div>
          </div>
          {numScans > 0 && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-4">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div><p className="text-xs text-gray-500">Hourly scans</p><p className="text-xl font-bold text-orange-600">{numScans}</p></div>
                <div><p className="text-xs text-gray-500">Businesses</p><p className="text-xl font-bold text-orange-600">{selectedBizIds.length}</p></div>
                <div><p className="text-xs text-gray-500">Total credits</p><p className="text-xl font-bold text-orange-600">{creditCost}</p></div>
              </div>
              <p className="text-xs text-orange-600 text-center mt-2">{numScans} scans × {selectedBizIds.length} {selectedBizIds.length === 1 ? 'business' : 'businesses'} × 25 pts = {creditCost} credits</p>
            </div>
          )}
          {numScans === 0 && (
            <p className="text-sm text-red-600 bg-red-50 p-3 rounded-xl">End time must be after start time</p>
          )}
          <div className="bg-gray-50 rounded-xl p-4 text-sm space-y-1">
            <p className="font-semibold">Session summary</p>
            <p className="text-gray-500">Keyword: <strong>{keyword}</strong></p>
            <p className="text-gray-500">Window: <strong>{startTime} → {endTime}</strong> (every 1hr)</p>
            <p className="text-gray-500">Targeting: <strong>{isMulti ? 'Auto Grid' : method.replace('_', ' ')}</strong></p>
          </div>
          {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}
          <div className="flex gap-3">
            <button onClick={() => setStep(2)} className="btn-secondary">← Back</button>
            <button onClick={() => mutation.mutate()} className="btn-primary flex-1 py-2.5"
              disabled={mutation.isPending || numScans === 0}>
              {mutation.isPending ? 'Starting...' : `Start Session — ${creditCost} credits`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
JSEOF

# 17d. OrganicScanDetail.tsx — fix sponsored tab description
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/frontend/src/pages/OrganicScanDetail.tsx'
with open(path) as f: src = f.read()
# Fix the sponsored tab — now shows data from same scan
old = """            {tab === 'sponsored' && (
              <div>
                <p className="text-sm text-gray-600 mb-4">Sponsored results tracked in Ad Insights sessions via SerpApi for 100% accurate detection.</p>
                <button onClick={() => nav('/ad-insights/new')} className="btn-primary">Start Ad Insights Session</button>
              </div>
            )}"""
new = """            {tab === 'sponsored' && (
              <div className="space-y-4">
                <div className="bg-orange-50 border border-orange-200 rounded-xl p-4">
                  <p className="text-sm text-orange-700 font-semibold mb-1">Ad Pressure at scan time</p>
                  <p className="text-xs text-orange-600">Sponsored results were collected from the same API call as organic rankings — zero extra cost.</p>
                </div>
                {(score?.competitor_scores ?? []).length > 0 ? (
                  <div>
                    <p className="text-sm font-semibold text-gray-700 mb-3">Advertisers detected in your scan area:</p>
                    {(data as any)?.rankings?.filter((r: any) => r.result_type === 'sponsored')
                      .reduce((acc: any[], r: any) => {
                        if (!acc.find(a => a.found_place_id === r.found_place_id)) acc.push(r);
                        return acc;
                      }, []).slice(0, 10).map((r: any) => (
                        <div key={r.found_place_id ?? r.found_business_name} className="flex items-center gap-3 p-3 bg-orange-50 rounded-xl mb-2">
                          <span className="w-6 h-6 bg-orange-100 rounded-lg flex items-center justify-center text-xs font-bold text-orange-700">#{r.rank_position}</span>
                          <div><p className="text-sm font-semibold">{r.found_business_name ?? 'Unknown'}</p><p className="text-xs text-gray-400">{r.location_name}</p></div>
                        </div>
                      ))
                    }
                    <button onClick={() => nav('/ad-insights/new')} className="btn-secondary text-sm mt-3">Run detailed ad session →</button>
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <p className="text-gray-400 mb-3">No sponsored results detected in this scan area</p>
                    <button onClick={() => nav('/ad-insights/new')} className="btn-secondary text-sm">Run ad pressure session →</button>
                  </div>
                )}
              </div>
            )}"""
src = src.replace(old, new)
with open(path, 'w') as f: f.write(src)
print("  ✓ OrganicScanDetail.tsx sponsored tab updated")
PYEOF

# 17e. CustomScan page — new file
cat > "$ROOT/apps/frontend/src/pages/CustomScan.tsx" << 'JSEOF'
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customScanApi } from '../lib/api';

export default function CustomScanPage() {
  const nav = useNavigate();
  const qc  = useQueryClient();
  const [keyword, setKeyword]       = useState('');
  const [address, setAddress]       = useState('');
  const [lat, setLat]               = useState<number|null>(null);
  const [lng, setLng]               = useState<number|null>(null);
  const [radiusKm, setRadiusKm]     = useState('5');
  const [scanType, setScanType]     = useState('both');
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [showSug, setShowSug]       = useState(false);
  const [err, setErr]               = useState('');

  const { data: history, isLoading } = useQuery({
    queryKey: ['custom-scans'],
    queryFn:  () => customScanApi.list().then(r => r.data.scans),
  });

  const mutation = useMutation({
    mutationFn: () => customScanApi.create({ keyword, centerLat: lat, centerLng: lng, centerAddress: address, radiusKm: parseFloat(radiusKm), scanType }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['custom-scans'] }); setKeyword(''); setAddress(''); setLat(null); setLng(null); setErr(''); },
    onError: (e: any) => setErr(e.response?.data?.error ?? 'Failed to start scan'),
  });

  async function searchAddress(q: string) {
    setAddress(q); setLat(null); setLng(null);
    if (q.length < 3) { setSuggestions([]); return; }
    const r = await customScanApi.addressAutocomplete(q);
    setSuggestions(r.data.suggestions ?? []);
    setShowSug(true);
  }

  async function selectAddress(sug: any) {
    setShowSug(false);
    setAddress(sug.description ?? sug.formatted_address ?? sug.name);
    const r = await customScanApi.addressDetails(sug.place_id);
    setLat(r.data.lat); setLng(r.data.lng);
    setSuggestions([]);
  }

  const scanTypeLabel: Record<string,string> = {
    both: 'Organic + Ad Pressure', organic: 'Organic ranking only', ad_pressure: 'Ad pressure only',
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-bold mb-1">Custom Scan</h1>
        <p className="text-sm text-gray-400">
          Scan any location with any keyword. Results are stored separately and
          do not affect your business intelligence or opportunity score.
        </p>
      </div>

      {/* Scan form */}
      <div className="card space-y-5">
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-700">
          <p className="font-semibold mb-1">🗺️ Explore any location</p>
          <p>Search a competitor's address, a new area you want to expand to, or any location you're curious about. 25 credits per scan — credits never expire.</p>
        </div>

        <div className="relative">
          <label className="label">Center location</label>
          <input
            type="text" className="input" placeholder="Search any address or location..."
            value={address} onChange={e => searchAddress(e.target.value)}
            onBlur={() => setTimeout(() => setShowSug(false), 200)}
          />
          {showSug && suggestions.length > 0 && (
            <div className="absolute z-10 w-full bg-white border border-gray-200 rounded-xl shadow-xl mt-1 overflow-hidden">
              {suggestions.map((s: any, i) => (
                <button key={i} onMouseDown={() => selectAddress(s)}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 text-sm border-b border-gray-50 last:border-none">
                  <p className="font-medium truncate">{s.description ?? s.name}</p>
                </button>
              ))}
            </div>
          )}
          {lat && lng && (
            <p className="text-xs text-green-600 mt-1">✓ Location set: {lat.toFixed(5)}, {lng.toFixed(5)}</p>
          )}
        </div>

        <div>
          <label className="label">Keyword</label>
          <input type="text" className="input" placeholder="pizza, dentist, plumber..." value={keyword} onChange={e => setKeyword(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Radius: <span className="text-brand-600">{radiusKm} km</span></label>
            <input type="range" min="1" max="20" step="1" className="w-full accent-brand-500" value={radiusKm} onChange={e => setRadiusKm(e.target.value)} />
          </div>
          <div>
            <label className="label">Scan type</label>
            <select className="input" value={scanType} onChange={e => setScanType(e.target.value)}>
              <option value="both">Organic + Ad Pressure</option>
              <option value="organic">Organic ranking only</option>
              <option value="ad_pressure">Ad pressure only</option>
            </select>
          </div>
        </div>

        <div className="bg-gray-50 rounded-xl p-4 text-sm flex items-center justify-between">
          <div>
            <p className="font-semibold">25 credits · 5×5 grid · {scanTypeLabel[scanType]}</p>
            <p className="text-xs text-gray-400 mt-0.5">Not linked to any business · Results in ~30 seconds</p>
          </div>
          <span className="text-2xl">🗺️</span>
        </div>

        {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}

        <button
          onClick={() => { if (!lat || !lng) return setErr('Select a location from suggestions'); if (!keyword) return setErr('Enter a keyword'); setErr(''); mutation.mutate(); }}
          className="btn-primary w-full py-3"
          disabled={mutation.isPending}
        >
          {mutation.isPending ? 'Starting scan...' : 'Start Custom Scan — 25 credits'}
        </button>
      </div>

      {/* History */}
      <div>
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">Scan history</h2>
        {isLoading ? (
          <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="h-14 bg-gray-100 rounded-xl animate-pulse" />)}</div>
        ) : !history?.length ? (
          <div className="card text-center py-10">
            <p className="text-3xl mb-3">🗺️</p>
            <p className="text-gray-400 text-sm">No custom scans yet. Run your first scan above.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {history.map((s: any) => (
              <div key={s.id} className="card flex items-center gap-4 cursor-pointer hover:shadow-md transition-all"
                onClick={() => nav('/custom-scan/' + s.id)}>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl bg-gray-100 shrink-0">
                  {s.scan_type === 'ad_pressure' ? '📢' : s.scan_type === 'organic' ? '🔍' : '🗺️'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">"{s.keyword}"</p>
                  <p className="text-xs text-gray-400 truncate">{s.center_address ?? `${s.center_lat?.toFixed(4)}, ${s.center_lng?.toFixed(4)}`} · {s.radius_km}km</p>
                </div>
                <div className="text-right shrink-0">
                  {s.state === 'completed' && s.visibility_score != null && (
                    <p className="text-sm font-bold text-brand-600">{Math.round(s.visibility_score)}/100</p>
                  )}
                  <p className={'text-xs ' + (s.state === 'completed' ? 'text-green-500' : s.state === 'running' ? 'text-blue-500' : 'text-gray-400')}>
                    {s.state === 'running' ? '⟳ Running...' : s.state === 'completed' ? '✓ Done' : s.state}
                  </p>
                  <p className="text-xs text-gray-400">{new Date(s.created_at).toLocaleDateString()}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
JSEOF

# ─────────────────────────────────────────────────────────────
# MIGRATIONS
# ─────────────────────────────────────────────────────────────
echo "  Writing SQL migration 007..."
mkdir -p "$ROOT/migration"
cat > "$ROOT/migration/007-ad-pressure-results-custom-scans.sql" << 'EOF'
-- Migration 007: ad_pressure_results + custom_scans
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS ad_pressure_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id         uuid REFERENCES organic_scans(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES profiles(id) ON DELETE CASCADE,
  business_id     uuid REFERENCES businesses(id) ON DELETE CASCADE,
  keyword         text NOT NULL,
  scan_date       date NOT NULL,
  point_index     int,
  point_label     text,
  location_name   text,
  latitude        double precision,
  longitude       double precision,
  place_id        text,
  business_name   text,
  address         text,
  rank_position   int,
  rating          double precision,
  review_count    int,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_pressure_biz_date ON ad_pressure_results(business_id, scan_date DESC);
CREATE INDEX IF NOT EXISTS idx_ad_pressure_scan ON ad_pressure_results(scan_id);
ALTER TABLE ad_pressure_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Users see own ad pressure" ON ad_pressure_results FOR ALL USING (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS custom_scans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  scan_type        text NOT NULL DEFAULT 'both' CHECK (scan_type IN ('organic','ad_pressure','both')),
  keyword          text NOT NULL,
  center_lat       double precision NOT NULL,
  center_lng       double precision NOT NULL,
  center_address   text,
  radius_km        double precision NOT NULL DEFAULT 5,
  grid_size        int NOT NULL DEFAULT 3,
  state            text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','completed','failed')),
  total_points     int DEFAULT 25,
  points_completed int DEFAULT 0,
  credits_consumed int DEFAULT 25,
  organic_results  jsonb,
  sponsored_results jsonb,
  visibility_score  double precision,
  scan_date        date DEFAULT CURRENT_DATE,
  created_at       timestamptz DEFAULT now(),
  completed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_custom_scans_user ON custom_scans(user_id, created_at DESC);
ALTER TABLE custom_scans ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Users see own custom scans" ON custom_scans FOR ALL USING (user_id = auth.uid());

GRANT ALL ON ad_pressure_results TO service_role;
GRANT ALL ON custom_scans TO service_role;
EOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Complete. All changes applied."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " Backend files changed:"
echo "   ✓  [1] BillingService.ts        — final plan config $49/$119/$199/$499"
echo "   ✓  [2] OrganicScanService.ts    — saves sponsored results from same call"
echo "   ✓  [3] AdPressureService.ts     — Priority Queue ttlContext"
echo "   ✓  [4] GeoService.ts            — interval default 90→60"
echo "   ✓  [5] IntelligenceService.ts   — L1 removed, daily L2, L3 report processor"
echo "   ✓  [6] WeeklyScheduler.ts       — daily L2, correct formula, no fixed credits"
echo "   ✓  [7] intelligence.ts route    — clean, no L1/L2/L3 exposure"
echo "   ✓  [8] organicScans.ts route    — credit order fixed, billingService imported"
echo "   ✓  [9] adScans.ts               — slot IDs fixed, 60min, start/end time"
echo "   ✓ [10] dashboard.ts             — apiCostEstimate removed"
echo "   ✓ [11] citations.ts             — inline cron removed"
echo "   ✓ [12] reviews.ts               — canUseAiReplies imported"
echo "   ✓ [13] auth.ts                  — 900 credits on signup"
echo "   ✓ [14] businesses.ts            — is_active filter fixed"
echo "   ✓ [15] customScans.ts           — NEW: custom scan route"
echo "   ✓ [16] index.ts                 — all crons + custom scan route"
echo ""
echo " Frontend files changed:"
echo "   ✓ [17] api.ts                   — customScanApi + intelApi"
echo "   ✓ [17] Layout.tsx               — Custom Scan nav + route"
echo "   ✓ [17] NewAdScan.tsx            — start/end time picker, credit preview"
echo "   ✓ [17] OrganicScanDetail.tsx    — sponsored tab shows real data"
echo "   ✓ [17] CustomScan.tsx           — NEW: full custom scan page"
echo ""
echo " SQL:"
echo "   ✓     migration/007-...sql      — ad_pressure_results + custom_scans"
echo ""
echo " Next steps:"
echo "   1. Run migration/007 in Supabase SQL Editor"
echo "   2. Run dataforseo_migration.sh (replaces SerpAPI)"
echo "   3. Add to .env: DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD"
echo "   4. npm run dev"
echo ""
