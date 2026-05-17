/**
 * Scanning Domain — BullMQ Worker
 * Processes organic scan jobs from the queue.
 * Concurrency 10 — 10 scans run simultaneously.
 */

import { Worker, type Job } from 'bullmq';
import { createBullMQConnection } from '../../infrastructure/cache/RedisClient.js';
import { organicScanService } from './OrganicScanService.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { releaseScanSlot } from '../../infrastructure/cache/CacheService.js';
import { eventBus, Events } from '../../infrastructure/events/EventBus.js';

let worker: Worker | null = null;

export function startOrganicScanWorker(): void {
  worker = new Worker(
    'organic-scans',
    async (job: Job) => {
      logger.info('[ScanWorker] Processing job', { jobId: job.id, scanId: job.data.scanId });
      await organicScanService.runScan(job.data);
    },
    {
      connection: createBullMQConnection(),
      concurrency: 10, // 10 scans simultaneously
    }
  );

  worker.on('completed', (job) => {
    logger.info('[ScanWorker] Job completed', { jobId: job.id });
  });

  worker.on('failed', async (job, err) => {
    logger.error('[ScanWorker] Job failed', { jobId: job?.id, error: err.message });
    if (job?.data?.scanId) {
      await db.from('organic_scans').update({
        state: 'failed',
        error_message: err.message,
      }).eq('id', job.data.scanId);

      await releaseScanSlot(job.data.userId);
      eventBus.publish(Events.SCAN_ORGANIC_FAILED, { scanId: job.data.scanId, error: err.message });
    }
  });

  worker.on('error', (err) => {
    logger.error('[ScanWorker] Worker error', { error: err.message });
  });

  logger.info('[ScanWorker] Organic scan worker started — concurrency: 10');
}

export async function stopOrganicScanWorker(): Promise<void> {
  if (worker) await worker.close();
}
