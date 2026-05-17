import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { generateReviewReply, generateBatchReplies, estimateRevenueLost } from '../../domains/reviews/GeminiService.js';
import { fetchGBPReviews, postGBPReply } from '../../domains/identity/GoogleMapsService.js';
import { serpFetchReviews, hasSerpApiKey } from '../../domains/serpapi/SerpApiService.js';

const router = Router();

// GET /api/reviews?businessId=xxx
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  const { data: reviews } = await supabase
    .from('reviews')
    .select('*')
    .eq('business_id', businessId as string)
    .eq('user_id', req.userId!)
    .order('review_date', { ascending: false });

  const all = reviews ?? [];
  const unanswered = all.filter(r => !r.is_replied && r.ai_reply_status !== 'posted');
  const needsApproval = all.filter(r => r.ai_reply_status === 'draft_ready' && r.requires_approval);

  // Get business info for GBP status
  const { data: biz } = await supabase
    .from('businesses')
    .select('name, google_place_id, last_review_sync')
    .eq('id', businessId as string)
    .single();

  const { data: profile } = await supabase
    .from('profiles')
    .select('gbp_connected')
    .eq('id', req.userId!)
    .single();

  res.json({
    reviews: all,
    stats: {
      total: all.length,
      unanswered: unanswered.length,
      needsApproval: needsApproval.length,
      revenueLost: estimateRevenueLost(unanswered.length),
      avgRating: all.length ? (all.reduce((s, r) => s + r.rating, 0) / all.length).toFixed(1) : '0',
    },
    gbpConnected: !!profile?.gbp_connected,
    lastSync: biz?.last_review_sync,
    canFetchWithoutGBP: hasSerpApiKey() && !!biz?.google_place_id,
  });
});

// POST /api/reviews/fetch — fetch reviews (works with or without GBP)
router.post('/fetch', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.body;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  const { data: biz } = await supabase
    .from('businesses')
    .select('name, google_place_id, gbp_location_id')
    .eq('id', businessId)
    .eq('user_id', req.userId!)
    .single();

  if (!biz) return res.status(404).json({ error: 'Business not found' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('gbp_connected, gbp_access_token')
    .eq('id', req.userId!)
    .single();

  let synced = 0;
  let source = 'serp';

  // Try GBP first if connected
  if (profile?.gbp_connected && profile?.gbp_access_token && biz.gbp_location_id) {
    source = 'gbp';
    const gbpReviews = await fetchGBPReviews(profile.gbp_access_token, biz.gbp_location_id);
    for (const rev of gbpReviews) {
      await supabase.from('reviews').upsert({
        user_id: req.userId, business_id: businessId,
        source: 'gbp',
        google_review_id: rev.reviewId,
        reviewer_name: rev.reviewerName,
        reviewer_photo_url: rev.reviewerPhoto,
        rating: rev.rating, review_text: rev.text,
        review_date: rev.date, is_replied: rev.isReplied,
        requires_approval: rev.rating <= 2,
        auto_reply_enabled: rev.rating >= 3,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'google_review_id', ignoreDuplicates: false });
      synced++;
    }
  } else if (hasSerpApiKey() && biz.google_place_id) {
    // Fallback to SerpApi — works without GBP
    source = 'serp';
    const serpReviews = await serpFetchReviews(biz.google_place_id, biz.name);
    for (const rev of serpReviews) {
      await supabase.from('reviews').upsert({
        user_id: req.userId, business_id: businessId,
        source: 'serp',
        google_review_id: rev.reviewId,
        reviewer_name: rev.reviewerName,
        reviewer_photo_url: rev.reviewerPhoto,
        rating: rev.rating, review_text: rev.text,
        review_date: rev.date, is_replied: rev.isReplied,
        requires_approval: rev.rating <= 2,
        auto_reply_enabled: rev.rating >= 3,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'google_review_id', ignoreDuplicates: false });
      synced++;
    }
  } else {
    return res.status(400).json({
      error: 'Cannot fetch reviews. Connect Google Business Profile or add your SerpApi key to enable automatic review fetching.',
    });
  }

  // Update last sync time
  await supabase.from('businesses').update({ last_review_sync: new Date().toISOString() }).eq('id', businessId);

  res.json({ synced, source });
});

// POST /api/reviews/generate-all
router.post('/generate-all', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.body;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  const { data: reviews } = await supabase
    .from('reviews')
    .select('*')
    .eq('business_id', businessId)
    .eq('user_id', req.userId!)
    .eq('is_replied', false)
    .in('ai_reply_status', ['pending', 'rejected']);

  if (!reviews?.length) return res.json({ generated: 0, message: 'No reviews need replies' });

  const { data: biz } = await supabase
    .from('businesses')
    .select('name, brand_voice')
    .eq('id', businessId)
    .single();

  res.json({ message: 'Generating AI replies...', count: reviews.length });

  // Background generation
  generateAllReplies(reviews, biz, req.userId!).catch(console.error);
});

async function generateAllReplies(reviews: any[], biz: any, userId: string) {
  const brandVoice = biz?.brand_voice ?? { tone: 'friendly' };
  const results = await generateBatchReplies(
    reviews.map(r => ({ id: r.id, reviewerName: r.reviewer_name ?? 'there', rating: r.rating, reviewText: r.review_text ?? '' })),
    biz?.name ?? 'our business',
    brandVoice
  );

  for (const result of results) {
    if (!result.reply) continue;
    const review = reviews.find(r => r.id === result.reviewId);
    const autoPost = review?.rating >= 3 && review?.auto_reply_enabled && brandVoice?.autoReply345 !== false;
    await supabase.from('reviews').update({
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

// POST /api/reviews/:id/approve
router.post('/:reviewId/approve', requireAuth, async (req: AuthRequest, res) => {
  const { editedReply } = req.body;
  const { data: review } = await supabase
    .from('reviews')
    .select('*, businesses(gbp_location_id)')
    .eq('id', req.params.reviewId)
    .eq('user_id', req.userId!)
    .single();

  if (!review) return res.status(404).json({ error: 'Review not found' });

  const replyText = editedReply ?? review.ai_reply_draft;
  if (!replyText) return res.status(400).json({ error: 'No reply text' });

  let posted = false;
  const { data: profile } = await supabase.from('profiles').select('gbp_access_token, gbp_connected').eq('id', req.userId!).single();

  if (profile?.gbp_connected && profile?.gbp_access_token && review.businesses?.gbp_location_id && review.google_review_id) {
    posted = await postGBPReply(profile.gbp_access_token, review.businesses.gbp_location_id, review.google_review_id, replyText);
  }

  await supabase.from('reviews').update({
    ai_reply_status: posted ? 'posted' : 'approved',
    posted_reply: replyText,
    posted_at: new Date().toISOString(),
    posted_by: req.userId!,
    is_replied: posted,
    updated_at: new Date().toISOString(),
  }).eq('id', req.params.reviewId);

  res.json({
    success: true, posted,
    message: posted ? 'Reply posted to Google' : 'Reply saved. Connect GBP to post to Google automatically.',
  });
});

// POST /api/reviews/:id/regenerate
router.post('/:reviewId/regenerate', requireAuth, async (req: AuthRequest, res) => {
  const { data: review } = await supabase
    .from('reviews')
    .select('*, businesses(name, brand_voice)')
    .eq('id', req.params.reviewId)
    .eq('user_id', req.userId!)
    .single();

  if (!review) return res.status(404).json({ error: 'Review not found' });

  const brandVoice = review.businesses?.brand_voice ?? { tone: 'friendly' };

  try {
    const reply = await generateReviewReply({
      reviewerName: review.reviewer_name ?? 'there',
      rating: review.rating,
      reviewText: review.review_text ?? '',
      businessName: review.businesses?.name ?? 'our business',
      brandVoice,
    });
    await supabase.from('reviews').update({
      ai_reply_draft: reply,
      ai_reply_status: 'draft_ready',
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.reviewId);
    res.json({ reply });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/reviews/:id/toggle-auto
router.patch('/:reviewId/toggle-auto', requireAuth, async (req: AuthRequest, res) => {
  const { enabled } = req.body;
  await supabase.from('reviews').update({
    auto_reply_enabled: enabled,
    updated_at: new Date().toISOString(),
  }).eq('id', req.params.reviewId).eq('user_id', req.userId!);
  res.json({ success: true });
});

export default router;
