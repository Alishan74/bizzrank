/**
 * WeeklyScheduler — all background cron logic
 * runDailyL2Scans()    — 1am UTC — full 25pt per kw per biz (replaces L1)
 * runWeeklyReports()   — Mon 2am — process 7 days L2 data, ZERO new API calls
 * runMonthlyReset()    — 1st month — credit reset
 * runDailyReviewSync() — 4am UTC — enqueue review sync all businesses
 *
 * Background scans use ZERO user credits.
 * Correct formula: locs × kws × 25 pts (NO ×(1+comps) — competitor data free)
 */
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { intelligenceService } from '../intelligence/IntelligenceService.js';
import { billingService } from '../billing/BillingService.js';
import { enqueueReviewSync } from '../../infrastructure/queue/QueueRegistry.js';
import { aiVisibilityService } from '../aivisibility/AIVisibilityService.js';
import { gbpGuardService } from '../gbpguard/GBPGuardService.js';

export class WeeklyScheduler {

  async runDailyL2Scans(): Promise<void> {
    logger.info('[Scheduler] Daily L2 start');
    // FIXED: paginate profiles — previously loaded ALL at once
    // At 200 users this caused memory pressure and 1,200 simultaneous BullMQ jobs
    const BATCH = 50;
    let offset  = 0;
    let scanned = 0, skipped = 0;

    while (true) {
      const { data: profiles } = await db.from('profiles')
        .select('id, plan')
        .range(offset, offset + BATCH - 1);

      if (!profiles?.length) break;

      for (const p of profiles) {
        try {
          const { data: bizs } = await db.from('businesses')
            .select('id').eq('user_id', p.id).neq('is_active', false);
          for (const b of (bizs ?? [])) {
            const kws = await this.getKeywords(b.id);
            if (!kws.length) { skipped++; continue; }
            await intelligenceService.runDailyL2Scan(b.id, p.id, kws)
              .catch(e => logger.error('[Scheduler] L2 fail', { bizId: b.id, error: e.message }));
            scanned++;
            // 100ms stagger between businesses to avoid BullMQ queue spike
            await new Promise(r => setTimeout(r, 100));
          }
        } catch (e: any) {
          logger.error('[Scheduler] Profile L2 fail', { profileId: p.id, error: e.message });
        }
      }

      if (profiles.length < BATCH) break;
      offset += BATCH;
      // 500ms pause between batches to avoid overwhelming DB
      await new Promise(r => setTimeout(r, 500));
    }

    logger.info('[Scheduler] Daily L2 done', { scanned, skipped });
  }

  async runWeeklyReports(): Promise<void> {
    logger.info('[Scheduler] Weekly L3 reports start');
    const { data: profiles } = await db.from('profiles').select('id, plan');
    if (!profiles?.length) return;
    for (const p of profiles) {
      const { data: bizs } = await db.from('businesses')
        .select('id').eq('user_id', p.id).neq('is_active', false);
      for (const b of (bizs ?? [])) {
        await intelligenceService.runWeeklyReport(b.id, p.id)
          .catch(e => logger.error('[Scheduler] L3 fail', { bizId: b.id, error: e.message }));
      }
    }
    logger.info('[Scheduler] Weekly reports done');
  }

  async runMonthlyReset(): Promise<void> {
    logger.info('[Scheduler] Monthly credit reset');
    await billingService.resetMonthlyCredits();
  }

  async runDailyReviewSync(): Promise<void> {
    logger.info('[Scheduler] Review sync start');
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    const { data: bizs } = await db.from('businesses')
      .select('id, user_id, google_place_id, name, last_review_sync')
      .neq('is_active', false).not('google_place_id', 'is', null);
    let queued = 0;
    for (const b of (bizs ?? [])) {
      if (!b.last_review_sync || b.last_review_sync < cutoff) {
        await enqueueReviewSync({ businessId: b.id, userId: b.user_id, googlePlaceId: b.google_place_id, businessName: b.name })
          .catch(e => logger.error('[Scheduler] Review sync queue fail', { bizId: b.id, error: e.message }));
        queued++;
      }
    }
    logger.info('[Scheduler] Review sync queued', { queued });
  }

  async runDailyGuardCheck(): Promise<void> {
    logger.info('[Scheduler] GBP Guard daily check');
    await gbpGuardService.runDailyCheck()
      .catch(e => logger.error('[Scheduler] Guard check failed', { error: e.message }));
  }

  async runWeeklyAIVisibilityChecks(): Promise<void> {
    logger.info('[Scheduler] AI Visibility weekly checks start');
    // FIXED: paginate — Supabase silently truncates at 1000 rows if no range()
    const BATCH = 50;
    let offset  = 0;
    let checked = 0;
 
    while (true) {
      const { data: profiles } = await db.from('profiles')
        .select('id, plan').range(offset, offset + BATCH - 1);
 
      if (!profiles?.length) break;
 
      for (const p of profiles) {
        try {
          const { data: bizs } = await db.from('businesses')
            .select('id').eq('user_id', p.id).neq('is_active', false);
          for (const b of (bizs ?? [])) {
            await aiVisibilityService.runWeeklyCheck(b.id, p.id)
              .catch(e => logger.error('[Scheduler] AI Visibility failed', { bizId: b.id, error: e.message }));
            // 5s stagger — respects AI API rate limits
            await new Promise(r => setTimeout(r, 5000));
            checked++;
          }
        } catch (e: any) {
          logger.error('[Scheduler] AI Visibility profile failed', { profileId: p.id, error: e.message });
        }
      }
 
      if (profiles.length < BATCH) break;
      offset += BATCH;
      await new Promise(r => setTimeout(r, 500)); // pause between batches
    }
 
    logger.info('[Scheduler] AI Visibility checks done', { checked });
  }

  private async getKeywords(businessId: string): Promise<string[]> {
    const { data } = await db.from('business_keywords')
      .select('keyword').eq('business_id', businessId).eq('is_active', true).order('display_order');
    return (data ?? []).map((k: any) => k.keyword);
  }
}

export const weeklyScheduler = new WeeklyScheduler();
