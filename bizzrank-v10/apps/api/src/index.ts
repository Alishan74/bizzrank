import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { logger } from './infrastructure/logger/Logger.js';

// Infrastructure
import './infrastructure/cache/RedisClient.js';
import { queues } from './infrastructure/queue/QueueRegistry.js';

// Domain workers
import { startOrganicScanWorker } from './domains/scanning/ScanWorker.js';
import { startReviewWorker } from './domains/reviews/ReviewWorker.js';
import { startAdSlotWorker } from './domains/adpressure/AdPressureService.js';

// Domain event handlers (subscribe to events)
import { leaderboardService } from './domains/leaderboard/LeaderboardService.js';
import { reviewService } from './domains/reviews/ReviewService.js';

// Routes
import authRoutes from './api/routes/auth.js';
import businessRoutes from './api/routes/businesses.js';
import competitorRoutes from './api/routes/competitors.js';
import organicScanRoutes from './api/routes/organicScans.js';
import adScanRoutes from './api/routes/adScans.js';
import reviewRoutes from './api/routes/reviews.js';
import leaderboardRoutes from './api/routes/leaderboard.js';
import citationRoutes from './api/routes/citations.js';
import dashboardRoutes from './api/routes/dashboard.js';
import profileRoutes from './api/routes/profile.js';

const app = express();

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/businesses', businessRoutes);
app.use('/api/competitors', competitorRoutes);
app.use('/api/organic-scans', organicScanRoutes);
app.use('/api/ad-scans', adScanRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/citations', citationRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/profile', profileRoutes);

// Health check
app.get('/health', (_, res) => res.json({
  status: 'ok', version: 'v10', time: new Date().toISOString(),
}));

// Global error handler
app.use((err: any, req: any, res: any, next: any) => {
  logger.error('[API] Unhandled error', { error: err.message, path: req.path });
  const status = err.statusCode ?? 500;
  res.status(status).json({ error: err.message ?? 'Internal server error' });
});

function start() {
  // Register domain event handlers
  leaderboardService.registerEventHandlers();
  reviewService.registerEventHandlers();

  // Start BullMQ workers
  startOrganicScanWorker();
  startAdSlotWorker();
  startReviewWorker();

  const PORT = parseInt(process.env.PORT ?? '3000');
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`BizzRank AI v10 running on port ${PORT}`);
    logger.info('Workers: organic-scans(10) · ad-slots(20) · review-sync(50)');
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Shutting down gracefully...');
  await Promise.all([
    queues.organicScans.close(),
    queues.adScanSlots.close(),
    queues.reviewSync.close(),
    queues.citations.close(),
  ]);
  process.exit(0);
});

process.on('uncaughtException', (err) => logger.error('Uncaught exception', { error: err.message }));
process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection', { reason }));

start();
