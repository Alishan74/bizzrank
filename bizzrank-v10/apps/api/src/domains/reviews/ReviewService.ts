/**
 * Reviews Domain
 * Owns all review fetching, AI replies, and posting.
 * Works WITHOUT GBP via SerpApi.
 * GBP only used for posting replies.
 * Reacts to scan.organic.completed to schedule 24h review sync.
 */

import { db } from '../../infrastructure/database/SupabaseClient.js';
import { eventBus, Events } from '../../infrastructure/events/EventBus.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { serpApiService } from '../serpapi/SerpApiService.js';
import { generateReviewReply, generateBatchReplies, estimateRevenueLost } from './GeminiService.js';
import type { ReviewSyncJob, ScanCompletedEvent } from '../../shared/types/contracts.js';

export class ReviewService {
  registerEventHandlers(): void {
    // React to scan completion — schedule review sync for that business
    eventBus.subscribe<ScanCompletedEvent>(
      Events.SCAN_ORGANIC_COMPLETED,
      async (event) => {
        const { businessId, userId } = event.payload;
        const { data: biz } = await db.from('businesses').select('google_place_id, name, last_review_sync').eq('id', businessId).single();
        if (!biz?.google_place_id) return;

        // Only sync if not synced in last 24 hours
        if (biz.last_review_sync) {
          const lastSync = new Date(biz.last_review_sync);
          const hoursSince = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60);
          if (hoursSince < 24) return;
        }

        // Enqueue review sync
        const { enqueueReviewSync } = await import('../../infrastructure/queue/QueueRegistry.js');
        await enqueueReviewSync({ businessId, userId, googlePlaceId: biz.google_place_id, businessName: biz.name });
      }
    );

    logger.info('[Reviews] Event handlers registered');
  }

  /**
   * Sync reviews for a business.
   * Called by BullMQ worker.
   * Works with or without GBP.
   */
  async syncReviews(job: ReviewSyncJob): Promise<void> {
    const { businessId, userId, googlePlaceId, businessName } = job;

    // Try GBP first if connected
    const { data: profile } = await db.from('profiles').select('gbp_connected, gbp_access_token').eq('id', userId).single();
    const { data: biz } = await db.from('businesses').select('gbp_location_id').eq('id', businessId).single();

    let synced = 0;

    if (profile?.gbp_connected && profile?.gbp_access_token && biz?.gbp_location_id) {
      // GBP path
      const { fetchGBPReviews } = await import('../identity/GBPService.js');
      const gbpReviews = await fetchGBPReviews(profile.gbp_access_token, biz.gbp_location_id);
      for (const rev of gbpReviews) {
        await this.upsertReview(userId, businessId, 'gbp', rev);
        synced++;
      }
    } else if (serpApiService.isConfigured()) {
      // SerpApi fallback — works without GBP
      const serpReviews = await serpApiService.fetchReviews(googlePlaceId);
      for (const rev of serpReviews) {
        await this.upsertReview(userId, businessId, 'serp', rev);
        synced++;
      }
    }

    await db.from('businesses').update({ last_review_sync: new Date().toISOString() }).eq('id', businessId);
    eventBus.publish(Events.REVIEW_FETCHED, { businessId, userId, count: synced });
    logger.info('[Reviews] Sync complete', { businessId, synced });
  }

  private async upsertReview(userId: string, businessId: string, source: string, rev: any) {
    await db.from('reviews').upsert({
      user_id: userId, business_id: businessId, source,
      google_review_id: rev.reviewId,
      reviewer_name: rev.reviewerName,
      reviewer_photo_url: rev.reviewerPhoto,
      rating: rev.rating, review_text: rev.text,
      review_date: rev.date, is_replied: rev.isReplied,
      requires_approval: rev.rating <= 2,
      auto_reply_enabled: rev.rating >= 3,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'google_review_id', ignoreDuplicates: false });
  }

  async getReviews(businessId: string, userId: string) {
    const { data: reviews } = await db.from('reviews').select('*').eq('business_id', businessId).eq('user_id', userId).order('review_date', { ascending: false });
    const { data: profile } = await db.from('profiles').select('gbp_connected').eq('id', userId).single();
    const { data: biz } = await db.from('businesses').select('name, google_place_id, last_review_sync').eq('id', businessId).single();

    const all = reviews ?? [];
    const unanswered = all.filter(r => !r.is_replied && r.ai_reply_status !== 'posted');

    return {
      reviews: all,
      stats: {
        total: all.length,
        unanswered: unanswered.length,
        needsApproval: all.filter(r => r.ai_reply_status === 'draft_ready' && r.requires_approval).length,
        revenueLost: estimateRevenueLost(unanswered.length),
        avgRating: all.length ? (all.reduce((s, r) => s + r.rating, 0) / all.length).toFixed(1) : '0',
      },
      gbpConnected: !!profile?.gbp_connected,
      lastSync: biz?.last_review_sync,
      canFetchWithoutGBP: serpApiService.isConfigured() && !!biz?.google_place_id,
    };
  }

  async fetchAndSave(businessId: string, userId: string) {
    const { data: biz } = await db.from('businesses').select('name, google_place_id, gbp_location_id').eq('id', businessId).eq('user_id', userId).single();
    if (!biz) throw new Error('Business not found');
    const { data: profile } = await db.from('profiles').select('gbp_connected, gbp_access_token').eq('id', userId).single();

    const job: ReviewSyncJob = {
      businessId, userId,
      googlePlaceId: biz.google_place_id ?? '',
      businessName: biz.name,
    };

    await this.syncReviews(job);
  }

  async generateAllReplies(businessId: string, userId: string) {
    const { data: reviews } = await db.from('reviews').select('*').eq('business_id', businessId).eq('user_id', userId).eq('is_replied', false).in('ai_reply_status', ['pending', 'rejected']);
    if (!reviews?.length) return { generated: 0 };

    const { data: biz } = await db.from('businesses').select('name, brand_voice').eq('id', businessId).single();
    const brandVoice = biz?.brand_voice ?? { tone: 'friendly' };

    // Run in background
    this.runBatchGeneration(reviews, biz?.name ?? 'our business', brandVoice).catch(console.error);
    return { count: reviews.length };
  }

  private async runBatchGeneration(reviews: any[], businessName: string, brandVoice: any) {
    const results = await generateBatchReplies(
      reviews.map(r => ({ id: r.id, reviewerName: r.reviewer_name ?? 'there', rating: r.rating, reviewText: r.review_text ?? '' })),
      businessName, brandVoice
    );
    for (const result of results) {
      if (!result.reply) continue;
      const review = reviews.find(r => r.id === result.reviewId);
      const autoPost = review?.rating >= 3 && review?.auto_reply_enabled && brandVoice?.autoReply345 !== false;
      await db.from('reviews').update({
        ai_reply_draft: result.reply,
        ai_reply_status: autoPost ? 'approved' : 'draft_ready',
        posted_reply: autoPost ? result.reply : null,
        posted_at: autoPost ? new Date().toISOString() : null,
        posted_by: autoPost ? 'auto' : null,
        is_replied: autoPost,
        updated_at: new Date().toISOString(),
      }).eq('id', result.reviewId);
    }
  }

  async approveReply(reviewId: string, userId: string, editedReply?: string) {
    const { data: review } = await db.from('reviews').select('*, businesses(gbp_location_id)').eq('id', reviewId).eq('user_id', userId).single();
    if (!review) throw new Error('Review not found');

    const replyText = editedReply ?? review.ai_reply_draft;
    if (!replyText) throw new Error('No reply text');

    let posted = false;
    const { data: profile } = await db.from('profiles').select('gbp_access_token, gbp_connected').eq('id', userId).single();

    if (profile?.gbp_connected && profile?.gbp_access_token && review.businesses?.gbp_location_id && review.google_review_id) {
      const { postGBPReply } = await import('../identity/GBPService.js');
      posted = await postGBPReply(profile.gbp_access_token, review.businesses.gbp_location_id, review.google_review_id, replyText);
    }

    await db.from('reviews').update({
      ai_reply_status: posted ? 'posted' : 'approved',
      posted_reply: replyText,
      posted_at: new Date().toISOString(),
      posted_by: userId,
      is_replied: posted,
      updated_at: new Date().toISOString(),
    }).eq('id', reviewId);

    return { posted, message: posted ? 'Reply posted to Google' : 'Reply saved. Connect GBP to post to Google.' };
  }

  async regenerateReply(reviewId: string, userId: string) {
    const { data: review } = await db.from('reviews').select('*, businesses(name, brand_voice)').eq('id', reviewId).eq('user_id', userId).single();
    if (!review) throw new Error('Review not found');

    const brandVoice = review.businesses?.brand_voice ?? { tone: 'friendly' };
    const reply = await generateReviewReply({
      reviewerName: review.reviewer_name ?? 'there',
      rating: review.rating, reviewText: review.review_text ?? '',
      businessName: review.businesses?.name ?? 'our business',
      brandVoice,
    });

    await db.from('reviews').update({ ai_reply_draft: reply, ai_reply_status: 'draft_ready', updated_at: new Date().toISOString() }).eq('id', reviewId);
    return { reply };
  }
}

export const reviewService = new ReviewService();
