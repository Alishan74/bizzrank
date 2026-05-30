/**
 * Review Intelligence Service
 * Gemini-powered theme extraction from customer reviews.
 * One Gemini Flash call per business per week (~$0.001).
 * Results cached in DB for 7 days, force-refreshable on demand.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import 'dotenv/config';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');

export interface ReviewTheme {
  theme: string;       // e.g. "Friendly Staff"
  count: number;       // how many reviews mention it
  example: string;     // one short quote
}

export interface ReviewIntelligence {
  businessId: string;
  positiveThemes: ReviewTheme[];
  negativeThemes: ReviewTheme[];
  emergingThemes: ReviewTheme[];   // new in last 30 days
  summary: string;                 // one-line headline
  sentiment: 'positive' | 'neutral' | 'negative';
  trend: 'improving' | 'stable' | 'declining';
  reviewsAnalyzed: number;
  generatedAt: string;
}

export class ReviewIntelligenceService {

  /**
   * Get review intelligence for a business.
   * Returns cached result if < 7 days old, otherwise generates fresh.
   */
  async getIntelligence(businessId: string, userId: string, forceRefresh = false): Promise<ReviewIntelligence | null> {
    // Check cache first (7-day TTL)
    if (!forceRefresh) {
      const cached = await this.getCached(businessId);
      if (cached) return cached;
    }

    // Fetch reviews from DB
    const { data: reviews } = await db.from('reviews')
      .select('rating, review_text, review_date, reviewer_name')
      .eq('business_id', businessId)
      .eq('user_id', userId)
      .not('review_text', 'is', null)
      .order('review_date', { ascending: false })
      .limit(100);

    // Check Gemini key first — give a clear error if not configured
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
      throw new Error('GEMINI_KEY_MISSING');
    }

    if (!reviews?.length || reviews.length < 3) {
      return null; // Not enough reviews
    }

    const { data: biz } = await db.from('businesses')
      .select('name').eq('id', businessId).single();

    try {
      const intel = await this.analyzeWithGemini(businessId, biz?.name ?? 'the business', reviews);
      await this.saveToDb(businessId, userId, intel);
      return intel;
    } catch (err: any) {
      logger.error('[ReviewIntel] Gemini analysis failed', { error: err.message, businessId });
      throw err;
    }
  }

  private async analyzeWithGemini(businessId: string, bizName: string, reviews: any[]): Promise<ReviewIntelligence> {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
      throw new Error('Gemini API key not configured');
    }

    // Prepare review text — keep it concise to minimize token usage
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const reviewLines = reviews.map(r => {
      const isRecent = r.review_date > thirtyDaysAgo ? ' [RECENT]' : '';
      return `${r.rating}★${isRecent}: "${r.review_text?.slice(0, 150)}"`;
    }).join('\n');

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }); // Flash = ~$0.001

    const prompt = `Analyze these ${reviews.length} customer reviews for "${bizName}" and extract themes.

REVIEWS:
${reviewLines}

Respond ONLY with valid JSON in this exact format:
{
  "positiveThemes": [
    {"theme": "theme name", "count": 5, "example": "short quote"},
    {"theme": "theme name", "count": 3, "example": "short quote"}
  ],
  "negativeThemes": [
    {"theme": "theme name", "count": 4, "example": "short quote"}
  ],
  "emergingThemes": [
    {"theme": "theme name (from [RECENT] reviews only)", "count": 2, "example": "short quote"}
  ],
  "summary": "One sentence: customers praise X but mention Y",
  "sentiment": "positive",
  "trend": "stable"
}

Rules:
- Up to 5 positive themes, 5 negative themes, 3 emerging themes
- Only include themes with 2+ mentions (or 1+ for emerging)
- emergingThemes: only from reviews marked [RECENT]
- sentiment: "positive" if avg rating > 4, "negative" if < 3, else "neutral"
- trend: "improving" if recent reviews better than older, "declining" if worse, else "stable"
- Keep theme names short (2-4 words)
- Keep examples under 60 characters
- Return empty arrays if no themes found`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

    const parsed = JSON.parse(text);

    return {
      businessId,
      positiveThemes: (parsed.positiveThemes ?? []).slice(0, 5),
      negativeThemes: (parsed.negativeThemes ?? []).slice(0, 5),
      emergingThemes: (parsed.emergingThemes ?? []).slice(0, 3),
      summary: parsed.summary ?? '',
      sentiment: parsed.sentiment ?? 'neutral',
      trend: parsed.trend ?? 'stable',
      reviewsAnalyzed: reviews.length,
      generatedAt: new Date().toISOString(),
    };
  }

  private async getCached(businessId: string): Promise<ReviewIntelligence | null> {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data } = await db.from('review_intelligence')
        .select('*')
        .eq('business_id', businessId)
        .gte('generated_at', sevenDaysAgo)
        .order('generated_at', { ascending: false })
        .limit(1).single();

      if (!data) return null;

      return {
        businessId,
        positiveThemes: data.positive_themes ?? [],
        negativeThemes: data.negative_themes ?? [],
        emergingThemes: data.emerging_themes ?? [],
        summary: data.summary ?? '',
        sentiment: data.sentiment ?? 'neutral',
        trend: data.trend ?? 'stable',
        reviewsAnalyzed: data.reviews_analyzed ?? 0,
        generatedAt: data.generated_at,
      };
    } catch {
      return null;
    }
  }

  private async saveToDb(businessId: string, userId: string, intel: ReviewIntelligence): Promise<void> {
    await db.from('review_intelligence').upsert({
      business_id: businessId,
      user_id: userId,
      positive_themes: intel.positiveThemes,
      negative_themes: intel.negativeThemes,
      emerging_themes: intel.emergingThemes,
      summary: intel.summary,
      sentiment: intel.sentiment,
      trend: intel.trend,
      reviews_analyzed: intel.reviewsAnalyzed,
      generated_at: intel.generatedAt,
    }, { onConflict: 'business_id' });

    logger.info('[ReviewIntel] Saved', {
      businessId,
      reviewsAnalyzed: intel.reviewsAnalyzed,
      positives: intel.positiveThemes.length,
      negatives: intel.negativeThemes.length,
    });
  }

  /**
   * Get cached negative theme names for a business — used by ReviewService
   * to inject known issues into Gemini reply prompts.
   *
   * Returns ONLY the theme names (e.g. ["Slow service", "Long wait"])
   * from the most recent cached review intelligence.
   *
   * Zero Gemini API calls — reads from the review_intelligence DB table.
   * Called by ReviewService.runBatchGeneration() before generating replies.
   */
  async getCachedThemes(businessId: string): Promise<string[]> {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data } = await db.from('review_intelligence')
        .select('negative_themes')
        .eq('business_id', businessId)
        .gte('generated_at', sevenDaysAgo)
        .order('generated_at', { ascending: false })
        .limit(1)
        .single();

      if (!data?.negative_themes?.length) return [];

      // Return theme names only — strip example quotes and counts
      return (data.negative_themes as Array<{ theme: string }>)
        .map(t => t.theme)
        .filter(Boolean)
        .slice(0, 5);
    } catch {
      return [];
    }
  }

  /**
   * Weekly refresh for all businesses with enough reviews.
   * Called by cron on Sunday 02:00 UTC.
   */
  async runWeeklyRefresh(): Promise<void> {
    logger.info('[ReviewIntel] Starting weekly refresh');

    const { data: businesses } = await db.from('businesses')
      .select('id, user_id, name')
      .eq('is_active', true);

    if (!businesses?.length) return;

    let refreshed = 0;
    for (const biz of businesses) {
      try {
        await this.getIntelligence(biz.id, biz.user_id, true);
        refreshed++;
        // Rate limit: avoid hitting Gemini too fast
        await new Promise(r => setTimeout(r, 1000));
      } catch (err: any) {
        logger.warn('[ReviewIntel] Refresh failed for business', {
          businessId: biz.id, error: err.message,
        });
      }
    }

    logger.info('[ReviewIntel] Weekly refresh complete', { refreshed });
  }
}

export const reviewIntelligenceService = new ReviewIntelligenceService();
