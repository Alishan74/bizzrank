/**
 * Leaderboard Domain
 * Owns all leaderboard computation.
 * Reacts to scan.organic.completed events — never called directly.
 * Stores top businesses per scan, invalidates Redis cache.
 */

import { db } from '../../infrastructure/database/SupabaseClient.js';
import { eventBus, Events } from '../../infrastructure/events/EventBus.js';
import { setLeaderboardCache, invalidateLeaderboardCache, getLeaderboardCache } from '../../infrastructure/cache/CacheService.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import type { ScanCompletedEvent } from '../../shared/types/contracts.js';

export class LeaderboardService {
  /**
   * Register event handlers.
   * Called once at startup.
   */
  registerEventHandlers(): void {
    eventBus.subscribe<ScanCompletedEvent>(
      Events.SCAN_ORGANIC_COMPLETED,
      async (event) => {
        await this.computeLeaderboard(
          event.payload.scanId,
          event.payload.userId,
          event.payload.businessId,
          event.payload.keyword,
          event.payload.clientGooglePlaceId
        );
      }
    );

    logger.info('[Leaderboard] Event handlers registered');
  }

  async getLeaderboard(businessId: string): Promise<any> {
    // Try Redis cache first
    const cached = await getLeaderboardCache(businessId);
    if (cached) return cached;

    // Fall back to DB
    const { data: latestScan } = await db
      .from('organic_scans')
      .select('id, scan_date, keyword')
      .eq('business_id', businessId)
      .eq('state', 'completed')
      .order('scan_date', { ascending: false })
      .limit(1)
      .single();

    if (!latestScan) return null;

    const { data: leaderboard } = await db
      .from('leaderboard_scores')
      .select('*')
      .eq('scan_id', latestScan.id)
      .order('leaderboard_rank');

    const result = {
      leaderboard: leaderboard ?? [],
      scanDate: latestScan.scan_date,
      keyword: latestScan.keyword,
      scanId: latestScan.id,
    };

    await setLeaderboardCache(businessId, result);
    return result;
  }

  private async computeLeaderboard(
    scanId: string, userId: string, businessId: string,
    keyword: string, clientPlaceId: string | null
  ): Promise<void> {
    const today = new Date().toISOString().split('T')[0];

    // Get all rankings for this scan
    const { data: rankings } = await db
      .from('organic_rankings')
      .select('found_place_id, found_business_name, found_address, found_rating, rank_position, latitude, longitude')
      .eq('scan_id', scanId)
      .not('found_place_id', 'is', null);

    if (!rankings?.length) return;

    // Aggregate per business
    const bizStats = new Map<string, {
      name: string; address: string; rating: number | null;
      green: number; yellow: number; red: number;
      appearances: number; rankSum: number;
    }>();

    for (const r of rankings) {
      if (!r.found_place_id || !r.found_business_name) continue;
      const existing = bizStats.get(r.found_place_id) ?? {
        name: r.found_business_name, address: r.found_address ?? '',
        rating: r.found_rating, green: 0, yellow: 0, red: 0,
        appearances: 0, rankSum: 0,
      };
      if (r.rank_position <= 3) existing.green++;
      else if (r.rank_position <= 10) existing.yellow++;
      else existing.red++;
      existing.appearances++;
      existing.rankSum += r.rank_position;
      bizStats.set(r.found_place_id, existing);
    }

    // Sort: green desc, yellow desc, avg rank asc
    const sorted = [...bizStats.entries()].sort(([, a], [, b]) => {
      if (b.green !== a.green) return b.green - a.green;
      if (b.yellow !== a.yellow) return b.yellow - a.yellow;
      return (a.rankSum / a.appearances) - (b.rankSum / b.appearances);
    });

    // Delete old and insert new
    await db.from('leaderboard_scores').delete().eq('scan_id', scanId);

    const rows = sorted.slice(0, 20).map(([placeId, biz], idx) => ({
      scan_id: scanId, user_id: userId, business_id: businessId,
      keyword, scan_date: today,
      place_id: placeId, place_name: biz.name,
      place_address: biz.address, place_rating: biz.rating,
      is_client_business: placeId === clientPlaceId,
      green_dots: biz.green, yellow_dots: biz.yellow, red_dots: biz.red,
      total_appearances: biz.appearances,
      avg_rank: Math.round((biz.rankSum / biz.appearances) * 100) / 100,
      leaderboard_rank: idx + 1,
    }));

    if (rows.length > 0) {
      await db.from('leaderboard_scores').insert(rows);
    }

    // Invalidate cache so next read gets fresh data
    await invalidateLeaderboardCache(businessId);

    logger.info('[Leaderboard] Computed', { scanId, businessId, entries: rows.length });
  }
}

export const leaderboardService = new LeaderboardService();
