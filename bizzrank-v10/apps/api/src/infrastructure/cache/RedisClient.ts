import Redis from 'ioredis';
import 'dotenv/config';

// Upstash requires TLS — use rediss:// protocol
const redisUrl = process.env.REDIS_URL!;

// Shared Redis instance for caching and rate limiting
export const redis = new Redis(redisUrl, {
  tls: {},
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => {
    if (times > 3) return null;
    return Math.min(times * 200, 2000);
  },
  lazyConnect: false,
});

redis.on('connect', () => console.log('[Redis] Connected to Upstash'));
redis.on('error', (err) => console.error('[Redis] Error:', err.message));

// Separate connection for BullMQ — BullMQ requires its own connection
export function createBullMQConnection() {
  return new Redis(redisUrl, {
    tls: {},
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,    // Required by BullMQ
  });
}
