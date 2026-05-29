import { Queue } from 'bullmq';
import { createBullMQConnection } from '../cache/RedisClient.js';
import { logger } from '../logger/Logger.js';

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};

function makeQueue(name: string) {
  return new Queue(name, { connection: createBullMQConnection(), defaultJobOptions });
}

export const queues = {
  organicScans: makeQueue('organic-scans'),
  adScanSlots:  makeQueue('ad-scan-slots'),
  reviewSync:   makeQueue('review-sync'),
  citations:    makeQueue('citation-audits'),
};

export async function enqueueOrganicScan(data: any) {
  // BullMQ job IDs cannot contain ':' — use '_' instead
  const job = await queues.organicScans.add('run-scan', data, {
    jobId: 'scan_' + data.scanId,
    timeout: 10 * 60 * 1000,
    priority: data.isAutomated ? 10 : 1,
  });
  logger.info('[Queue] Organic scan enqueued: ' + data.scanId, { jobId: job.id });
  return job;
}

export async function enqueueAdSlot(data: any, delayMs = 0) {
  const job = await queues.adScanSlots.add('run-slot', data, {
    jobId: 'slot_' + data.slotId,
    delay: delayMs,
    timeout: 5 * 60 * 1000,
  });
  logger.info('[Queue] Ad slot enqueued: ' + data.slotId + ' delay=' + delayMs + 'ms');
  return job;
}

export async function enqueueReviewSync(data: any) {
  const job = await queues.reviewSync.add('sync-reviews', data, {
    jobId: 'review_' + data.businessId + '_' + Date.now(),
    timeout: 2 * 60 * 1000,
  });
  return job;
}

export async function enqueueCitationAudit(data: any) {
  const job = await queues.citations.add('run-audit', data, {
    jobId: 'citation_' + data.businessId + '_' + Date.now(),
    timeout: 30 * 60 * 1000,
  });
  return job;
}

logger.info('[Queue] BullMQ queues initialized');
