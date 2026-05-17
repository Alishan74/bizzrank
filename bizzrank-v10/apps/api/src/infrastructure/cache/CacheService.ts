import { redis } from './RedisClient.js';

const SERP_TTL = 60 * 60;        // 1 hour
const BUSINESS_TTL = 60 * 60 * 24; // 24 hours
const LEADERBOARD_TTL = 60 * 60; // 1 hour

// ─── SERP CACHE ───────────────────────────────────────────────
export function makeSerpCacheKey(lat: number, lng: number, keyword: string): string {
  const roundedLat = Math.round(lat * 1000) / 1000;
  const roundedLng = Math.round(lng * 1000) / 1000;
  const cleanKeyword = keyword.toLowerCase().trim().replace(/\s+/g, '_');
  return `serp:${cleanKeyword}:${roundedLat}:${roundedLng}`;
}

export async function getSerpCache(key: string): Promise<any | null> {
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

export async function setSerpCache(key: string, data: any): Promise<void> {
  try {
    await redis.setex(key, SERP_TTL, JSON.stringify(data));
  } catch (err: any) {
    console.error('[Cache] Serp set error:', err.message);
  }
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
    if (count > limit) {
      await redis.decr(key);
      return false;
    }
    return true;
  } catch {
    return true; // Fail open — don't block scans if Redis is down
  }
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
  } catch {
    return null;
  }
}

export async function setLeaderboardCache(businessId: string, data: any): Promise<void> {
  try {
    await redis.setex(`leaderboard:${businessId}`, LEADERBOARD_TTL, JSON.stringify(data));
  } catch { /* non-critical */ }
}

export async function invalidateLeaderboardCache(businessId: string): Promise<void> {
  try {
    await redis.del(`leaderboard:${businessId}`);
  } catch { /* non-critical */ }
}
