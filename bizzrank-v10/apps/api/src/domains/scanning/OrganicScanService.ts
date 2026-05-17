/**
 * Scanning Domain — OrganicScanService
 * Owns all organic scan orchestration.
 * Communicates with other domains ONLY through events and contracts.
 * Never directly imports other domain services.
 */

import { db } from '../../infrastructure/database/SupabaseClient.js';
import { eventBus, Events } from '../../infrastructure/events/EventBus.js';
import { setScanProgress, checkConcurrentScans, releaseScanSlot } from '../../infrastructure/cache/CacheService.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { NoScanPointsError, NoLocationError, ScanNotFoundError } from '../../shared/errors/DomainErrors.js';
import { serpApiService } from '../serpapi/SerpApiService.js';
import { geoService } from '../geo/GeoService.js';
import type { ScanPoint, GridScore, HeatmapPoint, ScanJob } from '../../shared/types/contracts.js';

export class OrganicScanService {
  /**
   * Run a complete organic scan.
   * Called by BullMQ worker — runs in background.
   * Publishes progress events and final completed event.
   */
  async runScan(job: ScanJob): Promise<void> {
    const { scanId, userId, businessId, clientGooglePlaceId, competitors, keyword, points, radiusKm } = job;
    const today = new Date().toISOString().split('T')[0];

    logger.info('[Scanning] Starting organic scan', { scanId, keyword, points: points.length });

    await db.from('organic_scans').update({
      state: 'running',
      started_at: new Date().toISOString(),
      total_points: points.length,
      points_completed: 0,
    }).eq('id', scanId);

    eventBus.publish(Events.SCAN_ORGANIC_STARTED, { scanId, userId, businessId, keyword, totalPoints: points.length });

    // pointResults: Map<pointIndex, array of all businesses found>
    const pointResults = new Map<number, Array<{
      placeId: string; name: string; address: string;
      phone: string | null; rating: number | null; reviewCount: number | null;
      rank: number; lat: number; lng: number; locationName: string;
    }>>();

    const BATCH_SIZE = 3;
    let pointsCompleted = 0;

    for (let i = 0; i < points.length; i += BATCH_SIZE) {
      const batch = points.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (point) => {
        const results = await serpApiService.search(point.lat, point.lng, keyword, radiusKm * 1000);

        // Reverse geocode for real location name
        const locationName = await geoService.reverseGeocode(point.lat, point.lng);

        const resultsAtPoint = results.organic.map(r => ({
          placeId: r.placeId, name: r.name, address: r.address,
          phone: r.phone, rating: r.rating, reviewCount: r.reviewCount,
          rank: r.rank, lat: point.lat, lng: point.lng, locationName,
        }));

        pointResults.set(point.index, resultsAtPoint);
      }));

      pointsCompleted = Math.min(i + BATCH_SIZE, points.length);
      const percentComplete = Math.round((pointsCompleted / points.length) * 100);

      // Update DB and publish SSE progress event
      await db.from('organic_scans')
        .update({ points_completed: pointsCompleted })
        .eq('id', scanId);

      await setScanProgress(scanId, { pointsCompleted, totalPoints: points.length, percentComplete });
      eventBus.publish(Events.SCAN_ORGANIC_PROGRESS, { scanId, pointsCompleted, totalPoints: points.length, percentComplete });

      if (i + BATCH_SIZE < points.length) await new Promise(r => setTimeout(r, 400));
    }

    // Save all rankings
    await this.saveRankings(scanId, userId, businessId, keyword, today, points, pointResults);

    // Build grid scores
    const clientScore = this.buildGridScore(clientGooglePlaceId, 'Your Business', true, points, pointResults);
    const competitorScores = competitors.map(comp =>
      this.buildGridScore(comp.googlePlaceId, comp.name, false, points, pointResults)
    );

    // Save scores
    await db.from('organic_scores').insert({
      scan_id: scanId, user_id: userId, business_id: businessId,
      keyword, scan_date: today,
      organic_visibility_score: clientScore.visibilityScore,
      organic_avg_ranking: clientScore.avgRanking,
      organic_territory_dominance: clientScore.territoryDominance,
      organic_total_cells: points.length,
      organic_ranked_cells: clientScore.rankedCells,
      organic_top3_cells: clientScore.top3Cells,
      organic_top10_cells: clientScore.top10Cells,
      organic_heatmap_points: clientScore.heatmapPoints,
      competitor_scores: competitorScores,
    });

    // Mark scan complete
    await db.from('organic_scans').update({
      state: 'completed',
      points_completed: points.length,
      completed_at: new Date().toISOString(),
    }).eq('id', scanId);

    // Publish completed event — other domains react
    eventBus.publish(Events.SCAN_ORGANIC_COMPLETED, {
      scanId, userId, businessId, keyword,
      score: clientScore.visibilityScore,
      clientGooglePlaceId,
    });

    // Save discovered businesses passively
    this.saveDiscovered(pointResults).catch(console.error);

    // Release concurrent scan slot
    await releaseScanSlot(userId);

    logger.info('[Scanning] Scan complete', { scanId, score: clientScore.visibilityScore });
  }

  private buildGridScore(
    placeId: string | null,
    name: string,
    isClient: boolean,
    points: ScanPoint[],
    pointResults: Map<number, any[]>
  ): GridScore {
    const rankAtPoint = new Map<number, number>();

    if (placeId) {
      for (const [pointIndex, results] of pointResults) {
        const found = results.find(r => r.placeId === placeId);
        if (found) rankAtPoint.set(pointIndex, found.rank);
      }
    } else if (isClient) {
      for (const [pointIndex, results] of pointResults) {
        if (results.length > 0) rankAtPoint.set(pointIndex, results[0].rank);
      }
    }

    const ranks = [...rankAtPoint.values()];
    const top3 = ranks.filter(r => r <= 3).length;
    const top10 = ranks.filter(r => r <= 10).length;
    const avgRank = ranks.length > 0 ? ranks.reduce((s, r) => s + r, 0) / ranks.length : null;
    const score = points.length > 0
      ? (ranks.reduce((s, r) => s + Math.max(0, 1 - (r - 1) / 20), 0) / points.length) * 100
      : 0;
    const dominance = points.length > 0 ? (top3 / points.length) * 100 : 0;

    const heatmapPoints: HeatmapPoint[] = points.map(p => {
      const rank = rankAtPoint.get(p.index) ?? null;
      const results = pointResults.get(p.index) ?? [];
      const locationName = results[0]?.locationName ?? p.label;
      return {
        lat: p.lat, lng: p.lng, rank, label: p.label, locationName,
        intensity: rank ? Math.max(0, 1 - (rank - 1) / 20) : 0,
        googleMapsUrl: p.googleMapsUrl,
      };
    });

    return {
      placeId: placeId ?? '', name, isClientBusiness: isClient,
      visibilityScore: Math.round(score * 100) / 100,
      avgRanking: avgRank ? Math.round(avgRank * 100) / 100 : null,
      territoryDominance: Math.round(dominance * 100) / 100,
      top3Cells: top3, top10Cells: top10, rankedCells: ranks.length,
      totalCells: points.length, heatmapPoints,
    };
  }

  private async saveRankings(
    scanId: string, userId: string, businessId: string,
    keyword: string, scanDate: string,
    points: ScanPoint[], pointResults: Map<number, any[]>
  ) {
    const rows: any[] = [];
    for (const [pointIndex, results] of pointResults) {
      const point = points.find(p => p.index === pointIndex)!;
      const locationName = results[0]?.locationName ?? point.label;

      if (results.length === 0) {
        rows.push({
          scan_id: scanId, user_id: userId, business_id: businessId,
          keyword, scan_date: scanDate,
          point_index: pointIndex, point_label: point.label,
          location_name: locationName, google_maps_url: point.googleMapsUrl,
          latitude: point.lat, longitude: point.lng,
          found_place_id: null, found_business_name: null,
          rank_position: null, total_results: 0, result_type: 'organic',
        });
      } else {
        for (const r of results) {
          rows.push({
            scan_id: scanId, user_id: userId, business_id: businessId,
            keyword, scan_date: scanDate,
            point_index: pointIndex, point_label: point.label,
            location_name: locationName, google_maps_url: point.googleMapsUrl,
            latitude: point.lat, longitude: point.lng,
            found_place_id: r.placeId, found_business_name: r.name,
            found_address: r.address, found_phone: r.phone,
            found_rating: r.rating, found_review_count: r.reviewCount,
            rank_position: r.rank, total_results: results.length,
            result_type: 'organic',
          });
        }
      }
    }

    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await db.from('organic_rankings').insert(rows.slice(i, i + 100));
      if (error) logger.error('[Scanning] Rankings insert error', { error: error.message });
    }
  }

  private async saveDiscovered(pointResults: Map<number, any[]>) {
    const seen = new Map<string, any>();
    for (const [, results] of pointResults) {
      for (const r of results) {
        if (r.placeId && !seen.has(r.placeId)) seen.set(r.placeId, r);
      }
    }
    for (const [placeId, r] of seen) {
      await db.from('discovered_businesses').upsert({
        google_place_id: placeId, name: r.name, address: r.address,
        latitude: r.lat, longitude: r.lng,
        rating: r.rating, review_count: r.reviewCount,
        last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: 'google_place_id', ignoreDuplicates: false });
    }
  }
}

export const organicScanService = new OrganicScanService();
