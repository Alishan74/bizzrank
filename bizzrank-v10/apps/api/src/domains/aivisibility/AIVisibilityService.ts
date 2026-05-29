/**
 * AI Visibility Service
 *
 * Tracks whether a business appears when AI platforms answer
 * local queries — ChatGPT, Google AI Overviews, Perplexity, Gemini.
 *
 * Runs weekly as part of L3 report — Monday 2am UTC.
 * Also supports on-demand checks (costs credits).
 * Zero credits for weekly automated check — included in all plans.
 *
 * How it works:
 *   1. Build 20 natural language prompts per business based on
 *      their keywords, location, and category
 *   2. Send each prompt to ChatGPT API + Perplexity API
 *   3. Check if business name appears in each response
 *   4. Record position (1st, 2nd, 3rd mention etc.)
 *   5. Check competitors too — show share of voice
 *   6. Generate AI Visibility Score (0-100)
 *   7. Store results + generate actionable insights
 *
 * Cost: ~$0.001 per prompt × 20 prompts × 2 platforms = $0.04/business/week
 * Agency (5 businesses): $0.20/week = $0.80/month — negligible
 */

import { db } from '../../infrastructure/database/SupabaseClient.js';
import { logger } from '../../infrastructure/logger/Logger.js';

// ── Platform config ───────────────────────────────────────────
export const AI_PLATFORMS = ['chatgpt', 'perplexity', 'gemini', 'google_ai'] as const;
export type AIPlatform = typeof AI_PLATFORMS[number];

export interface AIVisibilityResult {
  platform:        AIPlatform;
  prompt:          string;
  promptType:      string;
  appeared:        boolean;
  mentionPosition: number | null;  // 1 = first mentioned, 2 = second, null = not mentioned
  mentionContext:  string | null;  // the sentence that mentioned the business
  competitorMentions: Array<{ name: string; position: number }>;
  rawResponse:     string;
  checkedAt:       string;
}

export interface AIVisibilityScore {
  overall:     number;  // 0-100
  chatgpt:     number;
  perplexity:  number;
  gemini:      number;
  google_ai:   number;
  promptsTested:  number;
  promptsPassed:  number;
  shareOfVoice:   number;  // % of prompts where you appear before competitors
  trend:          'improving' | 'stable' | 'declining';
  topInsight:     string;
  actions:        string[];
}

// ── Prompt templates ──────────────────────────────────────────
// Natural language queries customers actually use
function buildPrompts(
  businessName: string,
  keyword:      string,
  city:         string,
  category:     string | null,
  competitors:  string[],
): string[] {
  const cat  = category ?? keyword;
  const comp = competitors.slice(0, 3).join(', ') || 'other businesses';

  return [
    // Direct recommendation queries
    `What is the best ${keyword} in ${city}?`,
    `Can you recommend a good ${keyword} near ${city}?`,
    `Who is the top-rated ${keyword} in ${city}?`,
    `Which ${keyword} should I go to in ${city}?`,

    // Comparison queries
    `Compare ${keyword} options in ${city}`,
    `What are the most popular ${keyword} places in ${city}?`,
    `Which ${keyword} has the best reviews in ${city}?`,

    // Specific intent queries
    `Best ${keyword} in ${city} open late`,
    `Most trusted ${keyword} in ${city}`,
    `${keyword} in ${city} with good customer service`,

    // Category-specific queries
    `Where can I find ${cat} in ${city}?`,
    `Best ${cat} near ${city}`,
    `Highly recommended ${cat} in ${city}`,

    // Direct business queries (checks if AI knows the business)
    `Tell me about ${businessName} in ${city}`,
    `Is ${businessName} a good ${keyword} in ${city}?`,
    `What do people say about ${businessName}?`,

    // Competitor comparison
    `${businessName} vs ${competitors[0] ?? 'competitors'} in ${city} — which is better?`,

    // Near me intent
    `Best ${keyword} near me in ${city}`,
    `${keyword} recommendations in ${city}`,
    `Where to find the best ${keyword} in ${city}?`,
  ].slice(0, 20); // always exactly 20 prompts
}

// ── Check if business name appears in AI response ─────────────
function checkMention(
  response:     string,
  businessName: string,
  competitors:  string[],
): { appeared: boolean; position: number | null; context: string | null; competitorMentions: any[] } {
  const lower   = response.toLowerCase();
  const bizLow  = businessName.toLowerCase();

  // Find business mention
  const appeared  = lower.includes(bizLow);
  let position: number | null = null;
  let context:  string | null = null;

  if (appeared) {
    // Find position relative to competitors
    const allMentions: Array<{ name: string; index: number }> = [
      { name: businessName, index: lower.indexOf(bizLow) },
      ...competitors
        .filter(c => lower.includes(c.toLowerCase()))
        .map(c => ({ name: c, index: lower.indexOf(c.toLowerCase()) })),
    ].sort((a, b) => a.index - b.index);

    position = allMentions.findIndex(m => m.name === businessName) + 1;

    // Extract context sentence
    const idx      = lower.indexOf(bizLow);
    const start    = Math.max(0, response.lastIndexOf('.', idx) + 1);
    const end      = response.indexOf('.', idx + bizLow.length);
    context        = response.slice(start, end > 0 ? end + 1 : start + 200).trim();
  }

  // Find competitor mentions and their positions
  const competitorMentions = competitors
    .filter(c => lower.includes(c.toLowerCase()))
    .map((c, i) => ({
      name:     c,
      position: i + 1,
    }));

  return { appeared, position, context, competitorMentions };
}

// ── Call ChatGPT API ──────────────────────────────────────────
async function queryChatGPT(prompt: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return '';

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:       'gpt-4o-mini',
        max_tokens:  500,
        temperature: 0.3,
        messages: [
          {
            role:    'system',
            content: 'You are a helpful local search assistant. Answer local business questions with specific recommendations. Be concise.',
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return '';
    const data = await res.json() as any;
    return data?.choices?.[0]?.message?.content ?? '';
  } catch {
    return '';
  }
}

// ── Call Perplexity API ───────────────────────────────────────
async function queryPerplexity(prompt: string): Promise<string> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return '';

  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:       'llama-3.1-sonar-small-128k-online',
        max_tokens:  500,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return '';
    const data = await res.json() as any;
    return data?.choices?.[0]?.message?.content ?? '';
  } catch {
    return '';
  }
}

// ── Call Gemini API ───────────────────────────────────────────
async function queryGemini(prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return '';

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents:           [{ parts: [{ text: prompt }] }],
          generationConfig:   { maxOutputTokens: 500, temperature: 0.3 },
        }),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!res.ok) return '';
    const data = await res.json() as any;
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  } catch {
    return '';
  }
}

// ── Query platform router ─────────────────────────────────────
async function queryPlatform(platform: AIPlatform, prompt: string): Promise<string> {
  switch (platform) {
    case 'chatgpt':    return queryChatGPT(prompt);
    case 'perplexity': return queryPerplexity(prompt);
    case 'gemini':     return queryGemini(prompt);
    case 'google_ai':  return queryGemini(prompt); // uses Gemini under the hood
    default:           return '';
  }
}

// ── Which platforms are configured ───────────────────────────
function getActivePlatforms(): AIPlatform[] {
  const platforms: AIPlatform[] = [];
  if (process.env.OPENAI_API_KEY)     platforms.push('chatgpt');
  if (process.env.PERPLEXITY_API_KEY) platforms.push('perplexity');
  if (process.env.GEMINI_API_KEY) {
    platforms.push('gemini');
    platforms.push('google_ai');
  }
  return platforms;
}

// ── Generate insights from results ───────────────────────────
function generateInsights(
  businessName: string,
  results:      AIVisibilityResult[],
  score:        number,
): { topInsight: string; actions: string[] } {
  const appeared  = results.filter(r => r.appeared).length;
  const total     = results.length;
  const chatgptR  = results.filter(r => r.platform === 'chatgpt');
  const perpR     = results.filter(r => r.platform === 'perplexity');
  const chatgptPct = chatgptR.length ? chatgptR.filter(r => r.appeared).length / chatgptR.length * 100 : 0;
  const perpPct    = perpR.length    ? perpR.filter(r => r.appeared).length    / perpR.length    * 100 : 0;

  const actions: string[] = [];
  let topInsight = '';

  if (score === 0) {
    topInsight = `${businessName} does not appear in any AI platform recommendations yet.`;
    actions.push('Create or claim your Foursquare listing — ChatGPT uses it as a primary local data source');
    actions.push('Ensure your Google Business Profile is complete with category, description, and hours');
    actions.push('Get more reviews that mention your location and services by name');
    actions.push('Add your business to Yelp, TripAdvisor, and Apple Maps');
  } else if (score < 30) {
    topInsight = `${businessName} appears in ${appeared} of ${total} AI queries (${Math.round(appeared/total*100)}%). Visibility is low.`;
    actions.push('Update your business description on GBP to include specific service keywords');
    actions.push('Respond to all reviews — AI platforms factor in review engagement');
    actions.push('Ensure NAP (name, address, phone) is identical across all directories');
  } else if (score < 60) {
    topInsight = `${businessName} has moderate AI visibility. ${chatgptPct > perpPct ? 'Strong on ChatGPT but weak on Perplexity.' : 'Stronger on Perplexity than ChatGPT.'}`;
    actions.push('Build citations on industry-specific directories relevant to your category');
    actions.push('Add FAQ schema markup to your website to help AI extract structured answers');
  } else {
    topInsight = `${businessName} has strong AI visibility — appearing in ${Math.round(appeared/total*100)}% of AI recommendations.`;
    actions.push('Maintain consistent review responses to keep AI visibility strong');
    actions.push('Monitor competitor AI visibility to stay ahead');
  }

  return { topInsight, actions };
}

// ═══════════════════════════════════════════════════════════════
// Main service class
// ═══════════════════════════════════════════════════════════════
export class AIVisibilityService {

  // ── Run weekly check for one business ────────────────────────
  async runWeeklyCheck(
    businessId: string,
    userId:     string,
  ): Promise<AIVisibilityScore | null> {
    const activePlatforms = getActivePlatforms();
    if (!activePlatforms.length) {
      logger.debug('[AIVisibility] No AI API keys configured, skipping');
      return null;
    }

    // Fetch business data
    const { data: biz } = await db.from('businesses')
      .select('name, city, category, address')
      .eq('id', businessId).single();
    if (!biz) return null;

    // Fetch keywords
    const { data: kwRows } = await db.from('business_keywords')
      .select('keyword').eq('business_id', businessId).eq('is_active', true).limit(4);
    const keywords = (kwRows ?? []).map((k: any) => k.keyword);
    if (!keywords.length) return null;

    // Fetch competitors
    const { data: compRows } = await db.from('competitors')
      .select('name').eq('business_id', businessId).neq('is_active', false).limit(4);
    const competitorNames = (compRows ?? []).map((c: any) => c.name);

    // Extract city from address if not set
    const city = biz.city || biz.address?.split(',').slice(-2)[0]?.trim() || 'your area';

    // Run checks for each keyword × each platform
    const allResults: AIVisibilityResult[] = [];
    const keyword = keywords[0]; // primary keyword

    logger.info('[AIVisibility] Starting check', {
      businessId, businessName: biz.name, city, keyword,
      platforms: activePlatforms.length,
    });

    const prompts = buildPrompts(biz.name, keyword, city, biz.category, competitorNames);

    // Test on each active platform — stagger to avoid rate limits
    for (const platform of activePlatforms) {
      // Test a subset of prompts per platform (5 per platform = 20 total across 4 platforms)
      const platformPrompts = prompts.slice(
        activePlatforms.indexOf(platform) * 5,
        activePlatforms.indexOf(platform) * 5 + 5
      );

      for (const prompt of platformPrompts) {
        try {
          const response = await queryPlatform(platform, prompt);
          if (!response) continue;

          const { appeared, position, context, competitorMentions } =
            checkMention(response, biz.name, competitorNames);

          allResults.push({
            platform,
            prompt,
            promptType:         categorizePrompt(prompt),
            appeared,
            mentionPosition:    position,
            mentionContext:     context,
            competitorMentions,
            rawResponse:        response.slice(0, 500), // truncate for storage
            checkedAt:          new Date().toISOString(),
          });

          // Small delay to avoid rate limits
          await new Promise(r => setTimeout(r, 500));
        } catch (e: any) {
          logger.debug('[AIVisibility] Prompt failed', { platform, error: e.message });
        }
      }
    }

    if (!allResults.length) return null;

    // Calculate scores
    const score = this.calculateScore(allResults, activePlatforms);
    const { topInsight, actions } = generateInsights(biz.name, allResults, score.overall);

    const finalScore: AIVisibilityScore = {
      ...score,
      topInsight,
      actions,
    };

    // Save to DB
    await db.from('ai_visibility_results').insert({
      business_id:       businessId,
      user_id:           userId,
      keyword,
      city,
      overall_score:     finalScore.overall,
      chatgpt_score:     finalScore.chatgpt,
      perplexity_score:  finalScore.perplexity,
      gemini_score:      finalScore.gemini,
      google_ai_score:   finalScore.google_ai,
      prompts_tested:    finalScore.promptsTested,
      prompts_passed:    finalScore.promptsPassed,
      share_of_voice:    finalScore.shareOfVoice,
      trend:             finalScore.trend,
      top_insight:       finalScore.topInsight,
      actions:           finalScore.actions,
      raw_results:       allResults,
      checked_at:        new Date().toISOString(),
    });

    logger.info('[AIVisibility] Check complete', {
      businessId, score: finalScore.overall,
      appeared: finalScore.promptsPassed,
      total: finalScore.promptsTested,
    });

    return finalScore;
  }

  // ── Calculate visibility score ────────────────────────────────
  private calculateScore(
    results:  AIVisibilityResult[],
    platforms: AIPlatform[],
  ): Omit<AIVisibilityScore, 'topInsight' | 'actions'> {
    const total   = results.length;
    const passed  = results.filter(r => r.appeared).length;
    const overall = total > 0 ? Math.round((passed / total) * 100) : 0;

    const byPlatform: Record<string, number> = {};
    for (const platform of platforms) {
      const pResults = results.filter(r => r.platform === platform);
      byPlatform[platform] = pResults.length > 0
        ? Math.round((pResults.filter(r => r.appeared).length / pResults.length) * 100)
        : 0;
    }

    // Share of voice — % of prompts where we appear FIRST (before competitors)
    const firstMentions = results.filter(r => r.appeared && r.mentionPosition === 1).length;
    const shareOfVoice  = total > 0 ? Math.round((firstMentions / total) * 100) : 0;

    // Trend — compare to last week's score
    let trend: 'improving' | 'stable' | 'declining' = 'stable';
    // Will be updated by compare logic in getLatestScore

    return {
      overall,
      chatgpt:        byPlatform['chatgpt']    ?? 0,
      perplexity:     byPlatform['perplexity'] ?? 0,
      gemini:         byPlatform['gemini']     ?? 0,
      google_ai:      byPlatform['google_ai']  ?? 0,
      promptsTested:  total,
      promptsPassed:  passed,
      shareOfVoice,
      trend,
    };
  }

  // ── Get latest score for a business ──────────────────────────
  async getLatestScore(businessId: string, userId: string): Promise<{
    latest:    any | null;
    previous:  any | null;
    history:   any[];
    trend:     'improving' | 'stable' | 'declining';
  }> {
    const { data: history } = await db.from('ai_visibility_results')
      .select('*')
      .eq('business_id', businessId)
      .eq('user_id', userId)
      .order('checked_at', { ascending: false })
      .limit(8);

    const latest   = history?.[0]  ?? null;
    const previous = history?.[1]  ?? null;

    let trend: 'improving' | 'stable' | 'declining' = 'stable';
    if (latest && previous) {
      const diff = latest.overall_score - previous.overall_score;
      if (diff > 5)  trend = 'improving';
      if (diff < -5) trend = 'declining';
    }

    return { latest, previous, history: history ?? [], trend };
  }

  // ── Get competitor AI visibility comparison ───────────────────
  async getCompetitorComparison(businessId: string, userId: string): Promise<{
    business:    { name: string; score: number };
    competitors: Array<{ name: string; score: number; placeId: string }>;
  }> {
    const { data: biz } = await db.from('businesses')
      .select('name').eq('id', businessId).single();

    const { data: latest } = await db.from('ai_visibility_results')
      .select('overall_score, raw_results')
      .eq('business_id', businessId)
      .eq('user_id', userId)
      .order('checked_at', { ascending: false })
      .limit(1).single();

    const { data: comps } = await db.from('competitors')
      .select('id, name, google_place_id')
      .eq('business_id', businessId).neq('is_active', false);

    // Calculate how often competitors appear in raw results
    const rawResults: AIVisibilityResult[] = latest?.raw_results ?? [];
    const competitorScores = (comps ?? []).map((c: any) => {
      const mentions = rawResults.filter(r =>
        r.competitorMentions.some(m => m.name.toLowerCase().includes(c.name.toLowerCase()))
      ).length;
      const score = rawResults.length > 0
        ? Math.round((mentions / rawResults.length) * 100) : 0;
      return { name: c.name, score, placeId: c.google_place_id };
    });

    return {
      business:    { name: biz?.name ?? '', score: latest?.overall_score ?? 0 },
      competitors: competitorScores.sort((a, b) => b.score - a.score),
    };
  }

  // ── Manual on-demand check (costs credits) ────────────────────
  async runManualCheck(businessId: string, userId: string): Promise<AIVisibilityScore | null> {
    return this.runWeeklyCheck(businessId, userId);
  }

  // ── Get configured platforms ──────────────────────────────────
  getConfiguredPlatforms(): AIPlatform[] {
    return getActivePlatforms();
  }
}

// ── Helper: categorize prompt type ───────────────────────────
function categorizePrompt(prompt: string): string {
  if (prompt.toLowerCase().includes('compare') || prompt.toLowerCase().includes('vs')) return 'comparison';
  if (prompt.toLowerCase().includes('best') || prompt.toLowerCase().includes('top')) return 'recommendation';
  if (prompt.toLowerCase().includes('tell me about') || prompt.toLowerCase().includes('is ')) return 'brand_query';
  if (prompt.toLowerCase().includes('where') || prompt.toLowerCase().includes('near')) return 'local_intent';
  return 'general';
}

export const aiVisibilityService = new AIVisibilityService();
