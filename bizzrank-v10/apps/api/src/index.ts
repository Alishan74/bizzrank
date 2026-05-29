import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import 'dotenv/config';
import { logger } from './infrastructure/logger/Logger.js';
import './infrastructure/cache/RedisClient.js';
import { queues } from './infrastructure/queue/QueueRegistry.js';
import { startOrganicScanWorker } from './domains/scanning/ScanWorker.js';
import { startReviewWorker } from './domains/reviews/ReviewWorker.js';
import { startAdSlotWorker } from './domains/adpressure/AdPressureService.js';
import { weeklyScheduler } from './domains/scheduling/WeeklyScheduler.js';
import { leaderboardService } from './domains/leaderboard/LeaderboardService.js';

import authRoutes           from './api/routes/auth.js';
import businessRoutes       from './api/routes/businesses.js';
import competitorRoutes     from './api/routes/competitors.js';
import organicScanRoutes    from './api/routes/organicScans.js';
import adScanRoutes         from './api/routes/adScans.js';
import reviewRoutes         from './api/routes/reviews.js';
import leaderboardRoutes    from './api/routes/leaderboard.js';
import citationRoutes       from './api/routes/citations.js';
import dashboardRoutes      from './api/routes/dashboard.js';
import profileRoutes        from './api/routes/profile.js';
import orgRoutes            from './api/routes/orgs.js';
import intelligenceRoutes   from './api/routes/intelligence.js';
import keywordRoutes        from './api/routes/keywords.js';
import reviewIntelRoutes    from './api/routes/reviewIntelligence.js';
import customScanRoutes     from './api/routes/customScans.js';
import gbpGuardRoutes      from './api/routes/gbpGuard.js';
import aiVisibilityRoutes  from './api/routes/aiVisibility.js';

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth',                authRoutes);
app.use('/api/businesses',          businessRoutes);
app.use('/api/competitors',         competitorRoutes);
app.use('/api/organic-scans',       organicScanRoutes);
app.use('/api/ad-scans',            adScanRoutes);
app.use('/api/reviews',             reviewRoutes);
app.use('/api/leaderboard',         leaderboardRoutes);
app.use('/api/citations',           citationRoutes);
app.use('/api/dashboard',           dashboardRoutes);
app.use('/api/profile',             profileRoutes);
app.use('/api/orgs',                orgRoutes);
app.use('/api/intelligence',        intelligenceRoutes);
app.use('/api/keywords',            keywordRoutes);
app.use('/api/review-intelligence', reviewIntelRoutes);
app.use('/api/custom-scans',        customScanRoutes);
app.use('/api/gbp-guard',           gbpGuardRoutes);
app.use('/api/ai-visibility',        aiVisibilityRoutes);

try {
  const { default: configRoutes } = await import('./api/routes/config.js');
  app.use('/api/config', configRoutes);
} catch {}

app.get('/health', (_, res) => res.json({ status: 'ok', version: 'v10', time: new Date().toISOString() }));

app.use((err: any, req: any, res: any, _next: any) => {
  logger.error('[API] Unhandled error', { error: err.message, path: req.path });
  res.status(err.statusCode ?? 500).json({ error: err.message ?? 'Internal server error' });
});

function startCronJobs(): void {
  // Daily L2: full 25pt scan per kw per biz — posts Standard Queue tasks
  cron.schedule('0 1 * * *', async () => {
    logger.info('[Cron] Daily L2 — posting tasks');
    await weeklyScheduler.runDailyL2Scans().catch(e => logger.error('[Cron] L2 failed', { error: e.message }));
  }, { timezone: 'UTC' });

  // Collect DataForSEO Standard Queue results (30min after posting)
  cron.schedule('30 1 * * *', async () => {
    logger.info('[Cron] Collecting Standard Queue results');
    try {
      const mod = await import('./domains/serpapi/SerpApiService.js') as any;
      if (typeof mod.collectPendingTasks === 'function') {
        const stats = await mod.collectPendingTasks();
        logger.info('[Cron] Collect done', stats);
      }
    } catch (e: any) { logger.error('[Cron] Collect failed', { error: e.message }); }
  }, { timezone: 'UTC' });

  // Weekly L3 reports: Mon 2am — processes 7 days L2 data, ZERO new API calls
  cron.schedule('0 2 * * 1', async () => {
    logger.info('[Cron] Weekly L3 reports');
    await weeklyScheduler.runWeeklyReports().catch(e => logger.error('[Cron] L3 failed', { error: e.message }));
  }, { timezone: 'UTC' });

  // Daily review sync: 4am
  cron.schedule('0 4 * * *', async () => {
    logger.info('[Cron] Daily review sync');
    await weeklyScheduler.runDailyReviewSync().catch(e => logger.error('[Cron] Review sync failed', { error: e.message }));
  }, { timezone: 'UTC' });

  // Citation audits: Mon 9am — Growth+ only
  cron.schedule('0 9 * * 1', async () => {
    logger.info('[Cron] Citation audits');
    try {
      const { supabase } = await import('./infrastructure/database/SupabaseClient.js');
      const { data: due } = await supabase.from('citation_audits')
        .select('id,business_id,user_id,brightlocal_campaign_id,reference_name,reference_address,reference_phone')
        .lte('next_audit_date', new Date().toISOString().split('T')[0]).eq('status', 'completed');
      const mod = await import('./api/routes/citations.js') as any;
      if (typeof mod.runAuditBackground === 'function') {
        for (const a of due ?? []) {
          mod.runAuditBackground(a.id, a.business_id, a.user_id, a.reference_name, a.reference_address, a.reference_phone, a.brightlocal_campaign_id)
            .catch((e: any) => logger.error('[Cron] Citation failed', { id: a.id, error: e.message }));
        }
      }
    } catch (e: any) { logger.error('[Cron] Citations cron failed', { error: e.message }); }
  }, { timezone: 'UTC' });

  // AI Visibility: Wed 3am UTC — weekly AI platform checks (ChatGPT, Perplexity, Gemini)
  cron.schedule('0 3 * * 3', async () => {
    logger.info('[Cron] AI Visibility weekly checks');
    await weeklyScheduler.runWeeklyAIVisibilityChecks()
      .catch(e => logger.error('[Cron] AI Visibility failed', { error: e.message }));
  }, { timezone: 'UTC' });

  // GBP Guard: 5am UTC daily — checks all business + competitor profiles for changes
  cron.schedule('0 5 * * *', async () => {
    logger.info('[Cron] GBP Guard daily check');
    await weeklyScheduler.runDailyGuardCheck().catch(e => logger.error('[Cron] Guard failed', { error: e.message }));
  }, { timezone: 'UTC' });

  // Monthly credit reset: 1st of month 00:00
  cron.schedule('0 0 1 * *', async () => {
    logger.info('[Cron] Monthly credit reset');
    await weeklyScheduler.runMonthlyReset().catch(e => logger.error('[Cron] Reset failed', { error: e.message }));
  }, { timezone: 'UTC' });

  logger.info('[Cron] All jobs registered', {
    jobs: ['L2@01:00','Collect@01:30','L3@Mon02:00','Reviews@04:00','AIVis@Wed03:00','Guard@05:00','Citations@Mon09:00','Credits@1st'],
  });
}

function start() {
  leaderboardService.registerEventHandlers();
  startOrganicScanWorker();
  startAdSlotWorker();
  startReviewWorker();
  startCronJobs();
  const PORT = parseInt(process.env.PORT ?? '3000');
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`BizzRank AI v10 on port ${PORT}`);
    logger.info('Workers: scans(10) · ad-slots(20) · reviews(50)');
    logger.info('Crons: L2@01:00 · Collect@01:30 · L3@Mon02:00 · Reviews@04:00 · Credits@1st');
  });
}

process.on('SIGTERM', async () => {
  await Promise.all([queues.organicScans.close(), queues.adScanSlots.close(), queues.reviewSync.close(), queues.citations.close()]);
  process.exit(0);
});
process.on('uncaughtException',  e => logger.error('Uncaught exception',   { error: e.message }));
process.on('unhandledRejection', r => logger.error('Unhandled rejection',  { reason: r }));

start();
