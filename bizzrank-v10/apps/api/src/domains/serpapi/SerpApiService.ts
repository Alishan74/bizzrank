/**
 * DataForSEO Service — drop-in replacement for SerpApiService
 *
 * Routing by ttlContext:
 *   MANUAL_SCAN  → Live     ($0.002/call,  ~6s)       user watching progress bar
 *   AD_PRESSURE  → Priority ($0.0012/call, ~1min)     time-sensitive hourly slots
 *   WEEKLY_SCAN  → Standard ($0.0006/call, ~5min)     background cron, cron collect
 *   REVIEW_FETCH → Standard ($0.0006/call, ~5min)     background daily cron
 *
 * Interface identical to old SerpApiService — zero changes in callers.
 */

import 'dotenv/config';
import {
  makeSerpCacheKey, getSerpCache, setSerpCache,
  getSharedScanResult, setSharedScanResult,
  type SerpTtlContext,
} from '../../infrastructure/cache/CacheService.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import type { SearchResult, SearchResults, SerpReview } from '../../shared/types/contracts.js';

// ── Config ────────────────────────────────────────────────────
const DFS_BASE            = 'https://api.dataforseo.com/v3';
const DFS_MAPS_LIVE       = '/serp/google/maps/live/advanced';
const DFS_MAPS_TASK_POST  = '/serp/google/maps/task_post';
const DFS_MAPS_TASK_GET   = '/serp/google/maps/task_get/advanced';
const DFS_REVIEW_POST     = '/reviews/google/task_post';
const DFS_PLACE_DETAILS_POST = '/business_data/google/my_business/info/task_post';
const DFS_PLACE_DETAILS_GET  = '/business_data/google/my_business/info/task_get';
const DFS_REVIEW_GET      = '/reviews/google/task_get/advanced';

// Redis key prefix for pending Standard Queue task IDs
export const DFS_TASK_PREFIX = 'dfs:task:';
const TASK_TTL               = 60 * 60 * 2;  // 2 hours — auto-expire if never collected

// ── Auth ──────────────────────────────────────────────────────
function auth(): string {
  const l = process.env.DATAFORSEO_LOGIN    ?? '';
  const p = process.env.DATAFORSEO_PASSWORD ?? '';
  return 'Basic ' + Buffer.from(`${l}:${p}`).toString('base64');
}

const HEADERS = () => ({
  'Authorization': auth(),
  'Content-Type':  'application/json',
});

// ── Retry helper ──────────────────────────────────────────────
async function retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 2000): Promise<T> {
  let last: any;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (e: any) {
      last = e;
      if (i < attempts) await new Promise(r => setTimeout(r, delayMs * i));
    }
  }
  throw last;
}

// ── Parse DataForSEO Maps items → SearchResult[] ─────────────
function parseItems(
  items: any[], fallbackLat: number, fallbackLng: number
): { organic: SearchResult[]; sponsored: SearchResult[] } {
  const organic:   SearchResult[] = [];
  const sponsored: SearchResult[] = [];

  (items ?? []).forEach((r: any, i: number) => {
    const result: SearchResult = {
      placeId:     r.place_id ?? r.cid ?? `dfs_${i}`,
      name:        r.title ?? '',
      address:     r.address ?? r.address_info?.address ?? '',
      phone:       r.phone ?? null,
      website:     r.url ?? null,
      rating:      r.rating?.value ?? null,
      reviewCount: r.rating?.votes_count ?? null,
      category:    r.category ?? null,
      latitude:    r.latitude  ?? fallbackLat,
      longitude:   r.longitude ?? fallbackLng,
      rank:        0,
      isSponsored: r.is_paid ?? false,
      thumbnail:   r.main_image ?? null,
    };
    if (result.isSponsored) {
      result.rank = sponsored.length + 1;
      sponsored.push(result);
    } else {
      result.rank = organic.length + 1;
      organic.push(result);
    }
  });

  return { organic, sponsored };
}

// ── Live endpoint — synchronous ~6s ──────────────────────────
async function searchLive(
  lat: number, lng: number, keyword: string, radiusM: number
): Promise<{ organic: SearchResult[]; sponsored: SearchResult[] }> {
  const body = JSON.stringify([{
    keyword,
    location_coordinate: `${lat},${lng},${Math.min(radiusM, 50000)}`,
    language_code: 'en',
    depth: 20,
  }]);

  const res  = await fetch(`${DFS_BASE}${DFS_MAPS_LIVE}`, {
    method: 'POST', headers: HEADERS(), body,
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`DFS Live HTTP ${res.status}`);
  const data = await res.json() as any;
  const task = data?.tasks?.[0];
  if (!task || task.status_code !== 20000)
    throw new Error(`DFS Live: ${task?.status_message ?? 'unknown error'}`);

  const items = task?.result?.[0]?.items ?? [];
  return parseItems(items, lat, lng);
}

// ── Post task to queue (Standard or Priority) ─────────────────
async function postTask(
  lat: number, lng: number, keyword: string,
  radiusM: number, priority: 1 | 2, tag: string
): Promise<string> {
  const body = JSON.stringify([{
    keyword,
    location_coordinate: `${lat},${lng},${Math.min(radiusM, 50000)}`,
    language_code: 'en',
    depth: 20,
    priority, // 1 = Standard, 2 = Priority
    tag,
  }]);

  const res  = await fetch(`${DFS_BASE}${DFS_MAPS_TASK_POST}`, {
    method: 'POST', headers: HEADERS(), body,
  });

  if (!res.ok) throw new Error(`DFS Task post HTTP ${res.status}`);
  const data = await res.json() as any;
  const task = data?.tasks?.[0];
  if (!task || task.status_code !== 20100)
    throw new Error(`DFS Task post: ${task?.status_message ?? 'unknown'}`);

  return task.id as string;
}

// ── Get task result ───────────────────────────────────────────
async function getTask(
  taskId: string
): Promise<{ ready: boolean; organic: SearchResult[]; sponsored: SearchResult[] }> {
  const res  = await fetch(`${DFS_BASE}${DFS_MAPS_TASK_GET}/${taskId}`, {
    headers: HEADERS(),
  });

  if (!res.ok) throw new Error(`DFS Task get HTTP ${res.status}`);
  const data = await res.json() as any;
  const task = data?.tasks?.[0];

  if (!task) throw new Error('DFS: no task in response');
  if (task.status_code === 20100) return { ready: false, organic: [], sponsored: [] }; // still queued
  if (task.status_code !== 20000) throw new Error(`DFS Task: ${task.status_message}`);

  const coord = task?.data?.location_coordinate ?? '0,0';
  const [lat, lng] = coord.split(',').map(Number);
  return { ready: true, ...parseItems(task?.result?.[0]?.items ?? [], lat, lng) };
}

// ── Priority Queue search — polls every 15s up to 3 min ───────
async function searchPriority(
  lat: number, lng: number, keyword: string, radiusM: number, tag: string
): Promise<{ organic: SearchResult[]; sponsored: SearchResult[] }> {
  const taskId = await postTask(lat, lng, keyword, radiusM, 2, tag);

  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 15000)); // wait 15s
    const result = await getTask(taskId);
    if (result.ready) return { organic: result.organic, sponsored: result.sponsored };
  }

  logger.error('[DFS] Priority task timed out', { taskId, keyword });
  return { organic: [], sponsored: [] };
}

// ── Standard Queue — post task, store ID, return empty ────────
// Results collected by cron collect pass at 1:30am
async function postStandardTask(
  lat: number, lng: number, keyword: string, radiusM: number, tag: string
): Promise<void> {
  const taskId = await postTask(lat, lng, keyword, radiusM, 1, tag);

  // Store task ID in Redis for cron collect
  const { redis } = await import('../../infrastructure/cache/RedisClient.js');
  const meta = JSON.stringify({ taskId, lat, lng, keyword, tag, postedAt: Date.now() });
  await redis.setex(`${DFS_TASK_PREFIX}${taskId}`, TASK_TTL, meta);

  logger.debug('[DFS] Standard task posted', { taskId, keyword, lat, lng });
}

// ═══════════════════════════════════════════════════════════════
// SerpApiService — same interface as before, DataForSEO inside
// ═══════════════════════════════════════════════════════════════
export class SerpApiService {

  isConfigured(): boolean {
    const l = process.env.DATAFORSEO_LOGIN ?? '';
    return !!(l && l !== 'your_dataforseo_login' && l.includes('@'));
  }

  /**
   * Search Google Maps at specific lat/lng for a keyword.
   * Interface identical to old SerpApiService — callers unchanged.
   *
   * Routing:
   *   MANUAL_SCAN  → Live     (customer watching)
   *   AD_PRESSURE  → Priority (time-sensitive slot, ~1min)
   *   WEEKLY_SCAN  → Standard (overnight cron, cron collect at 1:30am)
   *   REVIEW_FETCH → Standard (daily cron)
   */
  async search(
    lat: number,
    lng: number,
    keyword: string,
    radiusMeters = 5000,
    ttlContext: SerpTtlContext = 'MANUAL_SCAN',
    scanId?: string,
  ): Promise<SearchResults> {
    if (!this.isConfigured()) {
      logger.warn('[DFS] Not configured — returning empty');
      return { organic: [], sponsored: [], fromCache: false };
    }

    // ── Layer 1: User Redis cache ─────────────────────────────
    const cacheKey = makeSerpCacheKey(lat, lng, keyword);
    const cached   = await getSerpCache(cacheKey);
    if (cached) return { ...cached, fromCache: true };

    // ── Layer 2: Shared cross-customer cache ──────────────────
    const today  = new Date().toISOString().split('T')[0];
    const shared = await getSharedScanResult(lat, lng, keyword, today);
    if (shared) {
      await setSerpCache(cacheKey, shared, ttlContext);
      return { ...shared, fromCache: true };
    }

    // ── Layer 3: Fresh DataForSEO call ────────────────────────
    try {
      const tag = `${ttlContext}_${scanId ?? Date.now()}_${Math.round(lat * 1000)}_${Math.round(lng * 1000)}`;

      if (ttlContext === 'MANUAL_SCAN') {
        // Live — customer is watching the progress bar
        const result = await retry(() => searchLive(lat, lng, keyword, radiusMeters));
        const payload = { organic: result.organic, sponsored: result.sponsored };
        await setSerpCache(cacheKey, payload, ttlContext);
        await setSharedScanResult(lat, lng, keyword, today, payload);
        return { ...payload, fromCache: false };

      } else if (ttlContext === 'AD_PRESSURE') {
        // Priority Queue — ad pressure slot needs result within ~1min
        const result = await retry(() => searchPriority(lat, lng, keyword, radiusMeters, tag), 2);
        const payload = { organic: result.organic, sponsored: result.sponsored };
        if (result.organic.length > 0 || result.sponsored.length > 0) {
          await setSerpCache(cacheKey, payload, ttlContext);
          await setSharedScanResult(lat, lng, keyword, today, payload);
        }
        return { ...payload, fromCache: false };

      } else {
        // Standard Queue — WEEKLY_SCAN / REVIEW_FETCH
        // Post task, return empty immediately
        // Cron collect at 1:30am will warm cache with results
        await postStandardTask(lat, lng, keyword, radiusMeters, tag).catch(err =>
          logger.error('[DFS] Standard post failed', { error: err.message })
        );
        return { organic: [], sponsored: [], fromCache: false };
      }

    } catch (err: any) {
      logger.error('[DFS] Search error', { error: err.message, keyword, ttlContext });
      return { organic: [], sponsored: [], fromCache: false };
    }
  }

  /**
   * Fetch reviews for a business.
   * Uses Standard Queue — called by daily review cron, not user-facing.
   * Interface identical to old SerpApiService.
   */
  async fetchReviews(placeId: string): Promise<SerpReview[]> {
    if (!this.isConfigured()) return [];

    const cacheKey = `dfs:reviews:${placeId}`;
    try {
      const { redis } = await import('../../infrastructure/cache/RedisClient.js');
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch { /* cache miss */ }

    try {
      // Post Standard Queue task
      const body = JSON.stringify([{
        place_id:      placeId,
        language_code: 'en',
        depth:         20,
        sort_by:       'newest',
        priority:      1,
      }]);

      const postRes  = await fetch(`${DFS_BASE}${DFS_REVIEW_POST}`, {
        method: 'POST', headers: HEADERS(), body,
      });
      if (!postRes.ok) throw new Error(`Reviews post HTTP ${postRes.status}`);
      const postData = await postRes.json() as any;
      const taskId   = postData?.tasks?.[0]?.id;
      if (!taskId) throw new Error('No task ID');

      // Poll up to 10 minutes (30s × 20 = 10min)
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 30000));

        const getRes = await fetch(`${DFS_BASE}${DFS_REVIEW_GET}/${taskId}`, {
          headers: HEADERS(),
        });
        if (!getRes.ok) continue;
        const getData = await getRes.json() as any;
        const task    = getData?.tasks?.[0];
        if (!task || task.status_code === 20100) continue; // still queued
        if (task.status_code !== 20000) break;

        const reviews: SerpReview[] = (task?.result?.[0]?.items ?? [])
          .slice(0, 20)
          .map((r: any, i: number) => ({
            reviewId:      r.review_id ?? `dfs_r_${i}`,
            reviewerName:  r.profile_name ?? 'Anonymous',
            reviewerPhoto: r.profile_image_url ?? null,
            rating:        r.rating?.value ?? 5,
            text:          r.review_text ?? '',
            date:          r.timestamp ?? new Date().toISOString(),
            isReplied:     !!r.owner_answer,
          }));

        // Cache for 12h
        try {
          const { redis } = await import('../../infrastructure/cache/RedisClient.js');
          await redis.setex(cacheKey, 60 * 60 * 12, JSON.stringify(reviews));
        } catch { /* non-critical */ }

        return reviews;
      }

      logger.warn('[DFS] Reviews task timed out', { placeId });
      return [];

    } catch (err: any) {
      logger.error('[DFS] Reviews error', { error: err.message });
      return [];
    }
  }

  /**
   * Fetch full GBP place details for a given Place ID.
   * Used by GBPGuardService to snapshot all 20 monitored fields daily.
   * Uses Standard Queue — non-urgent, runs at 5am with the guard cron.
   *
   * Returns the full place data object or null if not found/failed.
   * This method was MISSING before — causing GBP Guard to silently do nothing.
   */
  async fetchPlaceDetails(placeId: string): Promise<any | null> {
    if (!this.isConfigured()) return null;

    // Check Redis cache first (6h TTL — place details change slowly)
    const cacheKey = `dfs:place:${placeId}`;
    try {
      const { redis } = await import('../../infrastructure/cache/RedisClient.js');
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch { /* cache miss */ }

    try {
      // Post Standard Queue task for place details
      const body = JSON.stringify([{
        place_id:      placeId,
        language_code: 'en',
        priority:      1,  // Standard Queue
      }]);

      const postRes = await fetch(`${DFS_BASE}${DFS_PLACE_DETAILS_POST}`, {
        method: 'POST', headers: HEADERS(), body,
      });

      if (!postRes.ok) {
        logger.debug('[DFS] Place details post failed', { status: postRes.status, placeId });
        return null;
      }

      const postData = await postRes.json() as any;
      const taskId   = postData?.tasks?.[0]?.id;
      if (!taskId) return null;

      // Poll up to 5 minutes (30s × 10 = 5min) for place details
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 30000));

        const getRes = await fetch(`${DFS_BASE}${DFS_PLACE_DETAILS_GET}/${taskId}`, {
          headers: HEADERS(),
        });
        if (!getRes.ok) continue;

        const getData = await getRes.json() as any;
        const task    = getData?.tasks?.[0];
        if (!task || task.status_code === 20100) continue; // still queued
        if (task.status_code !== 20000) break;             // error

        const item = task?.result?.[0]?.items?.[0];
        if (!item) return null;

        // Map DataForSEO place details to our standard format
        const placeData = {
          name:                item.title ?? null,
          address:             item.address ?? null,
          phone:               item.phone ?? null,
          website:             item.url ?? null,
          description:         item.description ?? null,
          latitude:            item.latitude ?? null,
          longitude:           item.longitude ?? null,
          store_code:          item.store_code ?? null,
          opening_hours:       item.work_hours ?? null,
          primary_category:    item.category ?? null,
          secondary_categories: item.additional_categories ?? null,
          rating:              item.rating?.value ?? null,
          review_count:        item.rating?.votes_count ?? null,
          is_permanently_closed: item.is_claimed === false ? false : (item.is_permanently_closed ?? false),
          google_fid:          item.feature_id ?? null,
          google_cid:          item.cid ?? null,
        };

        // Cache for 6 hours
        try {
          const { redis } = await import('../../infrastructure/cache/RedisClient.js');
          await redis.setex(cacheKey, 60 * 60 * 6, JSON.stringify(placeData));
        } catch { /* non-critical */ }

        return placeData;
      }

      logger.debug('[DFS] Place details timed out', { placeId });
      return null;

    } catch (err: any) {
      logger.error('[DFS] Place details error', { placeId, error: err.message });
      return null;
    }
  }

}

// ── Cron collect pass — called from index.ts at 1:30am ────────
/**
 * Collects all pending Standard Queue results from Redis.
 * Warms both the user cache and shared cross-customer cache.
 * Dead-letters tasks older than 15 minutes.
 */
export async function collectPendingTasks(): Promise<{
  collected: number; pending: number; failed: number;
}> {
  const { redis } = await import('../../infrastructure/cache/RedisClient.js');
  const keys      = await redis.keys(`${DFS_TASK_PREFIX}*`);

  if (!keys.length) {
    logger.debug('[DFS] No pending tasks to collect');
    return { collected: 0, pending: 0, failed: 0 };
  }

  let collected = 0, pending = 0, failed = 0;
  const DEAD_THRESHOLD = 15 * 60 * 1000; // 15 minutes

  for (const key of keys) {
    try {
      const raw = await redis.get(key);
      if (!raw) { await redis.del(key); continue; }

      const meta = JSON.parse(raw) as {
        taskId: string; lat: number; lng: number;
        keyword: string; tag: string; postedAt: number;
      };

      const result = await getTask(meta.taskId);

      if (result.ready) {
        // Warm cache with collected result
        const cacheKey = makeSerpCacheKey(meta.lat, meta.lng, meta.keyword);
        const today    = new Date().toISOString().split('T')[0];
        const payload  = { organic: result.organic, sponsored: result.sponsored };

        await setSerpCache(cacheKey, payload, 'WEEKLY_SCAN');
        await setSharedScanResult(meta.lat, meta.lng, meta.keyword, today, payload);
        await redis.del(key);
        collected++;

        logger.debug('[DFS] Collected', {
          taskId: meta.taskId, keyword: meta.keyword,
          organic: result.organic.length, sponsored: result.sponsored.length,
        });

      } else if (Date.now() - meta.postedAt > DEAD_THRESHOLD) {
        // Dead letter — took too long
        logger.error('[DFS] Dead letter task', {
          taskId: meta.taskId, keyword: meta.keyword,
          ageMin: Math.round((Date.now() - meta.postedAt) / 60000),
        });
        await redis.del(key);
        failed++;

      } else {
        pending++; // still processing, check next pass
      }

    } catch (err: any) {
      logger.error('[DFS] Collect error', { key, error: err.message });
      failed++;
    }
  }

  logger.info('[DFS] Collect pass', { collected, pending, failed, total: keys.length });
  return { collected, pending, failed };
}

// ── Named exports for backward compat ─────────────────────────
export const serpApiService = new SerpApiService();

export function hasSerpApiKey(): boolean {
  return serpApiService.isConfigured();
}

export async function serpFetchReviews(
  placeId: string, _businessName?: string
): Promise<SerpReview[]> {
  return serpApiService.fetchReviews(placeId);
}
