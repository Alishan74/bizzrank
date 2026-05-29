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
