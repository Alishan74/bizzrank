import { Redis } from 'ioredis';
import 'dotenv/config';
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('[Redis] REDIS_URL not set');
const isTLS = redisUrl.startsWith('rediss://');
const tlsOpt = isTLS ? {} : { tls: {} };
export const redis = new Redis(redisUrl, { ...tlsOpt, maxRetriesPerRequest: 3, retryStrategy: (times: number) => { if (times > 3) return null; return Math.min(times * 200, 2000); }, lazyConnect: false });
redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (e: Error) => console.error('[Redis] Error:', e.message));
export function createBullMQConnection(): Redis { return new Redis(redisUrl as string, { ...tlsOpt, maxRetriesPerRequest: null, enableReadyCheck: false }); }
