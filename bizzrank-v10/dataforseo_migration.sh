#!/usr/bin/env bash
# BizzRank AI v10 — DataForSEO migration
# cd /workspaces/bizzrank/bizzrank-v10 && bash dataforseo_migration.sh
set -e
ROOT="$(pwd)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " BizzRank AI — DataForSEO Migration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Write DataForSEO SerpApiService.ts ────────────────
echo "  Writing SerpApiService.ts (DataForSEO)..."
mkdir -p "$ROOT/apps/api/src/domains/serpapi"
cat > "$ROOT/apps/api/src/domains/serpapi/SerpApiService.ts" << 'DFS_EOF'
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
DFS_EOF

# ── 2. Update BillingService credits ────────────────────
echo "  Updating BillingService.ts credits..."
python3 - "$ROOT" << 'PYEOF'
import sys, re
root = sys.argv[1]
path = root + '/apps/api/src/domains/billing/BillingService.ts'
with open(path) as f: src = f.read()
new_plans = '''export const PLANS: Record<string, PlanConfig> = {
  starter:      { name:'starter',      displayName:'Starter',     priceMonthly:49,   credits:900,   maxBusinesses:1,   maxCompetitorsPerLocation:1, maxKeywords:1, hasAiReplies:true  },
  growth:       { name:'growth',       displayName:'Growth',      priceMonthly:119,  credits:1600,  maxBusinesses:1,   maxCompetitorsPerLocation:2, maxKeywords:2, hasAiReplies:true  },
  pro:          { name:'pro',          displayName:'Pro',         priceMonthly:199,  credits:1800,  maxBusinesses:2,   maxCompetitorsPerLocation:3, maxKeywords:3, hasAiReplies:true  },
  agency:       { name:'agency',       displayName:'Agency',      priceMonthly:499,  credits:3500,  maxBusinesses:5,   maxCompetitorsPerLocation:4, maxKeywords:4, hasAiReplies:true  },
  enterprise:   { name:'enterprise',   displayName:'Enterprise',  priceMonthly:0,    credits:99999, maxBusinesses:999, maxCompetitorsPerLocation:999, maxKeywords:999, hasAiReplies:true },
  professional: { name:'professional', displayName:'Pro',         priceMonthly:199,  credits:1800,  maxBusinesses:5,   maxCompetitorsPerLocation:5, maxKeywords:3, hasAiReplies:true  },
};'''
src = re.sub(r'export const PLANS: Record<string, PlanConfig> = \{.*?\};', new_plans, src, flags=re.DOTALL)
with open(path, 'w') as f: f.write(src)
print('  ✓ BillingService credits updated')
PYEOF

# ── 3. Update index.ts cron ──────────────────────────────
echo "  Patching index.ts cron jobs..."
python3 - "$ROOT" << 'PYEOF'
import sys, re
root = sys.argv[1]
path = root + '/apps/api/src/index.ts'
with open(path) as f: src = f.read()
# Ensure cron import
if "import cron from" not in src:
    src = "import cron from 'node-cron';\n" + src
# Ensure collectPendingTasks import
if 'collectPendingTasks' not in src:
    src = src.replace(
        "import authRoutes",
        "import { collectPendingTasks } from './domains/serpapi/SerpApiService.js';\nimport authRoutes"
    )
# Add collect cron if not already present
if 'collectPendingTasks()' not in src:
    collect_cron = """
  // 1:30am UTC: collect Standard Queue results posted at 1:00am
  cron.schedule('30 1 * * *', async () => {
    logger.info('[Cron] Collecting DataForSEO Standard Queue results');
    try { const stats = await collectPendingTasks(); logger.info('[Cron] Collect done', stats); }
    catch (err: any) { logger.error('[Cron] Collect failed', { error: err.message }); }
  }, { timezone: 'UTC' });"""
    # Insert after the 1:00am cron block
    src = re.sub(
        r"(cron\.schedule\('0 1 \* \* \*'.*?\}, \{ timezone: 'UTC' \}\);)",
        r'\1' + collect_cron,
        src, flags=re.DOTALL, count=1
    )
with open(path, 'w') as f: f.write(src)
print('  ✓ index.ts collect cron added')
PYEOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Done. Next steps:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " 1. Add to apps/api/.env:"
echo "      DATAFORSEO_LOGIN=you@email.com"
echo "      DATAFORSEO_PASSWORD=your_password"
echo ""
echo " 2. Remove SERPAPI_KEY from .env"
echo ""
echo " 3. Restart: Ctrl+C -> npm run dev"
echo ""
echo " Cost routing:"
echo "   Manual scan    -> Live ($0.002/call, ~6s)"
echo "   Ad pressure    -> Priority ($0.0012/call, ~1min)"
echo "   Weekly/L1/Reviews -> Standard ($0.0006/call, ~5min, cron collect 1:30am)"
echo ""
