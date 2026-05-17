import { Queue } from 'bullmq';
import { createBullMQConnection } from '../cache/RedisClient.js';
import { logger } from '../logger/Logger.js';

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};

// One connection per queue
function makeQueue(name: string) {
  return new Queue(name, {
    connection: createBullMQConnection(),
    defaultJobOptions,
  });
}

export const queues = {
  organicScans:  makeQueue('organic-scans'),
  adScanSlots:   makeQueue('ad-scan-slots'),
  reviewSync:    makeQueue('review-sync'),
  citations:     makeQueue('citation-audits'),
};

// Add job helpers
export async function enqueueOrganicScan(data: any) {
  const job = await queues.organicScans.add('run-scan', data, {
    jobId: 'scan:' + data.scanId,
    timeout: 10 * 60 * 1000, // 10 minutes
  });
  logger.info(`[Queue] Organic scan enqueued: ${data.scanId}`, { jobId: job.id });
  return job;
}

export async function enqueueAdSlot(data: any, delayMs: number = 0) {
  const job = await queues.adScanSlots.add('run-slot', data, {
    jobId: 'slot:' + data.slotId,
    delay: delayMs,
    timeout: 5 * 60 * 1000, // 5 minutes
  });
  logger.info(`[Queue] Ad slot enqueued: ${data.slotId} delay=${delayMs}ms`);
  return job;
}

export async function enqueueReviewSync(data: any) {
  const job = await queues.reviewSync.add('sync-reviews', data, {
    jobId: 'review:' + data.businessId + ':' + Date.now(),
    timeout: 2 * 60 * 1000, // 2 minutes
  });
  return job;
}

export async function enqueueCitationAudit(data: any) {
  const job = await queues.citations.add('run-audit', data, {
    jobId: 'citation:' + data.businessId + ':' + Date.now(),
    timeout: 30 * 60 * 1000, // 30 minutes
  });
  return job;
}

logger.info('[Queue] BullMQ queues initialized');
