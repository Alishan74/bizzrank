import { Worker, type Job } from 'bullmq';
import { createBullMQConnection } from '../../infrastructure/cache/RedisClient.js';
import { reviewService } from './ReviewService.js';
import { logger } from '../../infrastructure/logger/Logger.js';

let worker: Worker | null = null;

export function startReviewWorker(): void {
  worker = new Worker(
    'review-sync',
    async (job: Job) => {
      logger.info('[ReviewWorker] Processing sync', { jobId: job.id, businessId: job.data.businessId });
      await reviewService.syncReviews(job.data);
    },
    {
      connection: createBullMQConnection(),
      concurrency: 50, // Many lightweight jobs
    }
  );

  worker.on('failed', (job, err) => {
    logger.error('[ReviewWorker] Job failed', { jobId: job?.id, error: err.message });
  });

  logger.info('[ReviewWorker] Review sync worker started — concurrency: 50');
}

export async function stopReviewWorker(): Promise<void> {
  if (worker) await worker.close();
}
