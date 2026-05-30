import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');

export interface BrandVoice {
  ownerName?: string;
  businessDescription?: string;
  tone: 'professional' | 'friendly' | 'casual' | 'formal' | 'luxury' | 'local_warm';
  emphasize?: string;
  avoid?: string;
  exampleReply?: string;
}

export interface ReviewContext {
  reviewerName: string;
  rating: number;
  reviewText: string;
  businessName: string;
  brandVoice: BrandVoice;
  existingReplies?: string[];
  // Negative themes from ReviewIntelligenceService — injected into
  // Gemini prompt for negative/neutral reviews so replies acknowledge
  // known recurring issues rather than ignoring them.
  // Example: ["Slow service", "Long wait times", "Parking issues"]
  knownIssues?: string[];
}

const TONE_GUIDE: Record<string, string> = {
  professional: 'professional but warm — polished, composed, genuine care',
  friendly: 'friendly and personable — like a local owner who knows their customers',
  casual: 'casual and relaxed — real, conversational, zero corporate speak',
  formal: 'formal and respectful — measured, courteous, dignified',
  luxury: 'refined and elevated — premium tone, understated elegance',
  local_warm: 'warm and community-focused — neighborly, authentic, small-business soul',
};

export async function generateReviewReply(ctx: ReviewContext): Promise<string> {
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
    throw new Error('Gemini API key not configured');
  }

  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
  const { brandVoice, reviewerName, rating, reviewText, businessName } = ctx;

  const ratingGuidance = rating <= 2
    ? `${rating}-star NEGATIVE review. Respond with genuine empathy. Do NOT be defensive. Acknowledge their concern. Offer to resolve privately.`
    : rating === 3
    ? `3-star NEUTRAL review. Acknowledge what went well, address what could be better.`
    : `${rating}-star POSITIVE review. Respond warmly and specifically — reference something from their actual review.`;

  // Inject known recurring issues for negative/neutral reviews only.
  // For positive reviews this context is irrelevant and would make replies odd.
  // knownIssues comes from ReviewIntelligenceService.getCached() — zero extra cost.
  const issuesContext = (ctx.knownIssues?.length && rating <= 3)
    ? `\nKNOWN RECURRING ISSUES customers mention: ${ctx.knownIssues.slice(0, 3).join(', ')}.`
      + `\nIf this review mentions any of these, acknowledge them specifically and show awareness that you're working to improve. Don't be defensive.`
    : '';

  const prompt = `You are ${brandVoice.ownerName ?? 'the business owner'} of "${businessName}".
Tone: ${TONE_GUIDE[brandVoice.tone] ?? TONE_GUIDE.friendly}
${brandVoice.emphasize ? `Always emphasize: ${brandVoice.emphasize}` : ''}
${brandVoice.avoid ? `Always avoid: ${brandVoice.avoid}` : ''}
${brandVoice.exampleReply ? `Learn style from this example (do NOT copy): "${brandVoice.exampleReply}"` : ''}
${issuesContext}

${ratingGuidance}

RULES: Never start with "Thank you for your review". Never use "valued customer". Never include phone numbers, URLs or discounts. Keep 3-4 sentences. Reference something specific from the review.

Reviewer: ${reviewerName}
Rating: ${rating}/5
Review: "${reviewText || '(Star rating only — no written text)'}"

Write ONE reply only. No quotes. No preamble. Just the reply text.`;

  const result = await model.generateContent(prompt);
  return result.response.text().trim().replace(/^["']|["']$/g, '').trim();
}

export async function generateBatchReplies(
  reviews: Array<{ id: string; reviewerName: string; rating: number; reviewText: string; knownIssues?: string[] }>,
  businessName: string,
  brandVoice: BrandVoice
): Promise<Array<{ reviewId: string; reply: string; error?: string }>> {
  const results = [];
  for (const review of reviews) {
    try {
      // Pass knownIssues through from ReviewService → ReviewContext → Gemini prompt
      const reply = await generateReviewReply({
        reviewerName: review.reviewerName,
        rating:       review.rating,
        reviewText:   review.reviewText,
        businessName,
        brandVoice,
        knownIssues:  review.knownIssues,
      });
      results.push({ reviewId: review.id, reply });
      await new Promise(r => setTimeout(r, 600));
    } catch (err: any) {
      results.push({ reviewId: review.id, reply: '', error: err.message });
    }
  }
  return results;
}

export function estimateRevenueLost(unansweredCount: number, avgOrderValue: number = 150): number {
  return Math.round(unansweredCount * avgOrderValue * 2.5);
}
