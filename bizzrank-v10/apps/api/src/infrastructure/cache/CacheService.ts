/**
 * Cache Infrastructure — CacheService
 * UPDATED:
 *   - Tiered SerpAPI TTLs (weekly scan = 6h, manual = 2h, ad = 30min)
 *   - Geo cache helpers (Redis hot + Supabase permanent — see GeoService)
 *   - Intelligence level state tracking per user
 *   - Shared scan result deduplication helpers
 */

import { redis } from './RedisClient.js';

// ─── SerpAPI TTLs (tiered by use case) ───────────────────────
export const SERP_TTL = {
  WEEKLY_SCAN:  60 * 60 * 6,   // 6h  — automated weekly scans (rankings move slowly)
  MANUAL_SCAN:  60 * 60 * 2,   // 2h  — user-triggered rescans
  AD_PRESSURE:  60 * 30,       // 30m — sponsored results rotate faster
  REVIEW_FETCH: 60 * 60 * 12,  // 12h — reviews don't change minute-to-minute
} as const;

export type SerpTtlContext = keyof typeof SERP_TTL;

const GEO_TTL        = 60 * 60 * 24 * 30; // 30 days Redis — permanent in Supabase
const LEADERBOARD_TTL = 60 * 60;           // 1h
const INTEL_STATE_TTL = 60 * 60 * 24;      // 24h
const SHARED_SCAN_TTL = 60 * 60 * 6;       // 6h — shared between customers

// ─── SERP CACHE ───────────────────────────────────────────────
export function makeSerpCacheKey(lat: number, lng: number, keyword: string): string {
  const rLat = Math.round(lat * 1000) / 1000;
  const rLng = Math.round(lng * 1000) / 1000;
  const kw   = keyword.toLowerCase().trim().replace(/\s+/g, '_');
  return `serp:${kw}:${rLat}:${rLng}`;
}

export async function getSerpCache(key: string): Promise<any | null> {
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

export async function setSerpCache(
  key: string,
  data: any,
  context: SerpTtlContext = 'MANUAL_SCAN'
): Promise<void> {
  try {
    await redis.setex(key, SERP_TTL[context], JSON.stringify(data));
  } catch (err: any) {
    console.error('[Cache] SerpAPI set error:', err.message);
  }
}

// ─── SHARED SCAN DEDUPLICATION ───────────────────────────────
// When two customers scan the same keyword at the same location on the
// same day, the second one reuses the first customer's fresh results.
// This is the biggest cost lever at scale.

export function makeSharedScanKey(lat: number, lng: number, keyword: string, date: string): string {
  const rLat = Math.round(lat * 1000) / 1000;
  const rLng = Math.round(lng * 1000) / 1000;
  const kw   = keyword.toLowerCase().trim().replace(/\s+/g, '_');
  return `shared:${kw}:${rLat}:${rLng}:${date}`;
}

export async function getSharedScanResult(
  lat: number, lng: number, keyword: string, date: string
): Promise<any | null> {
  try {
    const key = makeSharedScanKey(lat, lng, keyword, date);
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

export async function setSharedScanResult(
  lat: number, lng: number, keyword: string, date: string, data: any
): Promise<void> {
  try {
    const key = makeSharedScanKey(lat, lng, keyword, date);
    await redis.setex(key, SHARED_SCAN_TTL, JSON.stringify(data));
  } catch (err: any) {
    console.error('[Cache] Shared scan set error:', err.message);
  }
}

// ─── GEO CACHE (Redis hot layer) ──────────────────────────────
// Redis provides sub-millisecond lookup.
// Supabase geo_cache table provides permanent storage (see GeoService).

export function makeGeoKey(lat: number, lng: number): string {
  const rLat = Math.round(lat * 1000) / 1000;
  const rLng = Math.round(lng * 1000) / 1000;
  return `geo:${rLat}:${rLng}`;
}

export async function getGeoCache(lat: number, lng: number): Promise<string | null> {
  try {
    return await redis.get(makeGeoKey(lat, lng));
  } catch { return null; }
}

export async function setGeoCache(lat: number, lng: number, name: string): Promise<void> {
  try {
    await redis.setex(makeGeoKey(lat, lng), GEO_TTL, name);
  } catch { /* non-critical */ }
}

// ─── INTELLIGENCE LEVEL STATE ──────────────────────────────────
// Tracks the current intelligence level (0-3) per user.
// Updated by the IntelligenceService during escalation.

export interface IntelLevelState {
  level: 0 | 1 | 2 | 3;
  activatedAt: string;
  reason: string;
  apiCostEstimate: number;
}

export async function getIntelLevel(userId: string): Promise<IntelLevelState | null> {
  try {
    const val = await redis.get(`intel:level:${userId}`);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

export async function setIntelLevel(userId: string, state: IntelLevelState): Promise<void> {
  try {
    await redis.setex(`intel:level:${userId}`, INTEL_STATE_TTL, JSON.stringify(state));
  } catch { /* non-critical */ }
}

export async function clearIntelLevel(userId: string): Promise<void> {
  try { await redis.del(`intel:level:${userId}`); } catch { /* non-critical */ }
}

// ─── CACHE CONFIDENCE SCORE ───────────────────────────────────
// Tracks how fresh the cached data is per business.
// Degrades over time; reset when L1 confirms no change or L3 runs.

export interface CacheConfidence {
  score: number;       // 0-100
  lastL3: string;      // ISO timestamp of last full scan
  lastL1: string;      // ISO timestamp of last L1 validation
  changesDetected: boolean;
}

export async function getCacheConfidence(businessId: string): Promise<CacheConfidence | null> {
  try {
    const val = await redis.get(`cache:confidence:${businessId}`);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

export async function setCacheConfidence(businessId: string, data: CacheConfidence): Promise<void> {
  try {
    await redis.setex(`cache:confidence:${businessId}`, 60 * 60 * 24 * 7, JSON.stringify(data));
  } catch { /* non-critical */ }
}

export async function degradeCacheConfidence(
  businessId: string,
  reason: 'competitor_move' | 'visibility_drop' | 'review_spike' | 'time_decay',
  amount: number
): Promise<void> {
  try {
    const existing = await getCacheConfidence(businessId);
    if (!existing) return;
    const newScore = Math.max(0, existing.score - amount);
    await setCacheConfidence(businessId, {
      ...existing,
      score: newScore,
      changesDetected: newScore < 60,
    });
  } catch { /* non-critical */ }
}

// ─── SCAN PROGRESS (SSE) ─────────────────────────────────────
export async function setScanProgress(scanId: string, data: object): Promise<void> {
  try {
    await redis.setex(`scan:progress:${scanId}`, 60 * 30, JSON.stringify(data));
    await redis.publish(`scan:progress:${scanId}`, JSON.stringify(data));
  } catch { /* non-critical */ }
}

// ─── RATE LIMITER ─────────────────────────────────────────────
export async function checkConcurrentScans(userId: string, limit: number): Promise<boolean> {
  try {
    const key = `scan:active:${userId}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60 * 60);
    if (count > limit) { await redis.decr(key); return false; }
    return true;
  } catch { return true; }
}

export async function releaseScanSlot(userId: string): Promise<void> {
  try {
    const key = `scan:active:${userId}`;
    const val = await redis.decr(key);
    if (val < 0) await redis.set(key, 0);
  } catch { /* non-critical */ }
}

// ─── LEADERBOARD CACHE ───────────────────────────────────────
export async function getLeaderboardCache(businessId: string): Promise<any | null> {
  try {
    const val = await redis.get(`leaderboard:${businessId}`);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

export async function setLeaderboardCache(businessId: string, data: any): Promise<void> {
  try {
    await redis.setex(`leaderboard:${businessId}`, LEADERBOARD_TTL, JSON.stringify(data));
  } catch { /* non-critical */ }
}

export async function invalidateLeaderboardCache(businessId: string): Promise<void> {
  try { await redis.del(`leaderboard:${businessId}`); } catch { /* non-critical */ }
}
