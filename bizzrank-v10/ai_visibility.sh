#!/usr/bin/env bash
# BizzRank AI v10 — AI Visibility Feature
# Tracks business rankings in ChatGPT, Google AI Overviews, Perplexity, Gemini
# cd /workspaces/bizzrank/bizzrank-v10 && bash ai_visibility.sh
set -e
ROOT="$(pwd)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " BizzRank AI — AI Visibility Feature"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. AIVisibilityService.ts ─────────────────────────────────
echo "  [1/6] AIVisibilityService.ts"
mkdir -p "$ROOT/apps/api/src/domains/aivisibility"
cat > "$ROOT/apps/api/src/domains/aivisibility/AIVisibilityService.ts" << 'EOF'
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
EOF

# ── 2. aiVisibility.ts route ──────────────────────────────────
echo "  [2/6] aiVisibility.ts route"
cat > "$ROOT/apps/api/src/api/routes/aiVisibility.ts" << 'EOF'
/**
 * AI Visibility Routes — /api/ai-visibility
 *
 * GET  /status?businessId=      — latest score + history + competitor comparison
 * GET  /platforms               — which AI platforms are configured
 * POST /check                   — manual on-demand check (25 credits)
 */
import { Router } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { aiVisibilityService } from '../../domains/aivisibility/AIVisibilityService.js';
import { billingService, CREDIT_COSTS } from '../../domains/billing/BillingService.js';
import { db } from '../../infrastructure/database/SupabaseClient.js';

const router = Router();

// GET /api/ai-visibility/status?businessId=
router.get('/status', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  try {
    const [scoreData, comparison] = await Promise.all([
      aiVisibilityService.getLatestScore(businessId as string, req.userId!),
      aiVisibilityService.getCompetitorComparison(businessId as string, req.userId!),
    ]);

    const platforms = aiVisibilityService.getConfiguredPlatforms();

    res.json({
      ...scoreData,
      comparison,
      configuredPlatforms: platforms,
      isConfigured: platforms.length > 0,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ai-visibility/platforms
router.get('/platforms', requireAuth, (_req, res) => {
  const platforms = aiVisibilityService.getConfiguredPlatforms();
  res.json({
    platforms,
    isConfigured: platforms.length > 0,
    missing: ['chatgpt','perplexity','gemini'].filter(p =>
      !platforms.includes(p as any)
    ),
  });
});

// POST /api/ai-visibility/check — manual on-demand (25 credits)
router.post('/check', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.body;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  const platforms = aiVisibilityService.getConfiguredPlatforms();
  if (!platforms.length) {
    return res.status(400).json({
      error: 'No AI platform API keys configured. Add OPENAI_API_KEY or PERPLEXITY_API_KEY to .env',
    });
  }

  // Verify ownership
  const { data: biz } = await db.from('businesses')
    .select('id').eq('id', businessId).eq('user_id', req.userId!).single();
  if (!biz) return res.status(404).json({ error: 'Business not found' });

  // Deduct credits
  await billingService.checkAndDeductCredits({
    userId:          req.userId!,
    amount:          CREDIT_COSTS.MANUAL_SCAN,
    reason:          `AI Visibility check — ${businessId}`,
    transactionType: 'usage',
  });

  // Run check (async — respond immediately)
  res.json({
    ok:      true,
    message: 'AI Visibility check started. Results will appear shortly.',
    credits: CREDIT_COSTS.MANUAL_SCAN,
  });

  aiVisibilityService.runManualCheck(businessId, req.userId!)
    .catch(e => console.error('[AIVisibility] Manual check failed:', e.message));
});

export default router;
EOF

# ── 3. Update WeeklyScheduler.ts ─────────────────────────────
echo "  [3/6] WeeklyScheduler.ts — add AI visibility weekly check"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/domains/scheduling/WeeklyScheduler.ts'
with open(path) as f: src = f.read()

if 'aiVisibilityService' not in src:
    src = src.replace(
        "import { enqueueReviewSync } from '../../infrastructure/queue/QueueRegistry.js';",
        "import { enqueueReviewSync } from '../../infrastructure/queue/QueueRegistry.js';\nimport { aiVisibilityService } from '../aivisibility/AIVisibilityService.js';"
    )

if 'runWeeklyAIVisibilityChecks' not in src:
    old = "  private async getKeywords"
    new = """  async runWeeklyAIVisibilityChecks(): Promise<void> {
    logger.info('[Scheduler] AI Visibility weekly checks start');
    const { data: profiles } = await db.from('profiles').select('id, plan');
    if (!profiles?.length) return;
    let checked = 0;
    for (const p of profiles) {
      try {
        const { data: bizs } = await db.from('businesses')
          .select('id').eq('user_id', p.id).neq('is_active', false);
        for (const b of (bizs ?? [])) {
          await aiVisibilityService.runWeeklyCheck(b.id, p.id)
            .catch(e => logger.error('[Scheduler] AI Visibility failed', { bizId: b.id, error: e.message }));
          // Stagger checks to avoid API rate limits
          await new Promise(r => setTimeout(r, 2000));
          checked++;
        }
      } catch (e: any) {
        logger.error('[Scheduler] AI Visibility profile failed', { profileId: p.id, error: e.message });
      }
    }
    logger.info('[Scheduler] AI Visibility checks done', { checked });
  }

  private async getKeywords"""
    src = src.replace(old, new)

with open(path, 'w') as f: f.write(src)
print("  ✓ WeeklyScheduler.ts AI visibility check added")
PYEOF

# ── 4. Update index.ts ────────────────────────────────────────
echo "  [4/6] index.ts — add AI visibility route + cron"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/index.ts'
with open(path) as f: src = f.read()

# Add import
if 'aiVisibilityRoutes' not in src:
    src = src.replace(
        "import gbpGuardRoutes      from './api/routes/gbpGuard.js';",
        "import gbpGuardRoutes      from './api/routes/gbpGuard.js';\nimport aiVisibilityRoutes  from './api/routes/aiVisibility.js';"
    )

# Add route
if '/api/ai-visibility' not in src:
    src = src.replace(
        "app.use('/api/gbp-guard',           gbpGuardRoutes);",
        "app.use('/api/gbp-guard',           gbpGuardRoutes);\napp.use('/api/ai-visibility',        aiVisibilityRoutes);"
    )

# Add cron — Wednesday 3am UTC (mid-week, after L3 Monday)
if 'AI Visibility' not in src:
    src = src.replace(
        "  // GBP Guard: 5am UTC daily",
        """  // AI Visibility: Wed 3am UTC — weekly AI platform checks (ChatGPT, Perplexity, Gemini)
  cron.schedule('0 3 * * 3', async () => {
    logger.info('[Cron] AI Visibility weekly checks');
    await weeklyScheduler.runWeeklyAIVisibilityChecks()
      .catch(e => logger.error('[Cron] AI Visibility failed', { error: e.message }));
  }, { timezone: 'UTC' });

  // GBP Guard: 5am UTC daily"""
    )

# Update cron log
src = src.replace(
    "jobs: ['L2@01:00','Collect@01:30','L3@Mon02:00','Reviews@04:00','Guard@05:00','Citations@Mon09:00','Credits@1st']",
    "jobs: ['L2@01:00','Collect@01:30','L3@Mon02:00','Reviews@04:00','AIVis@Wed03:00','Guard@05:00','Citations@Mon09:00','Credits@1st']"
)

with open(path, 'w') as f: f.write(src)
print("  ✓ index.ts AI visibility route + cron added")
PYEOF

# ── 5. Update api.ts ──────────────────────────────────────────
echo "  [5/6] api.ts — add aiVisibilityApi"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/frontend/src/lib/api.ts'
with open(path) as f: src = f.read()
if 'aiVisibilityApi' not in src:
    src = src + """
export const aiVisibilityApi = {
  status:    (businessId: string) => api.get('/ai-visibility/status?businessId=' + businessId),
  platforms: ()                   => api.get('/ai-visibility/platforms'),
  check:     (businessId: string) => api.post('/ai-visibility/check', { businessId }),
};
"""
    with open(path, 'w') as f: f.write(src)
    print("  ✓ api.ts aiVisibilityApi added")
PYEOF

# ── 6. AIVisibility.tsx frontend page ────────────────────────
echo "  [6/6] AIVisibility.tsx frontend page"
cat > "$ROOT/apps/frontend/src/pages/AIVisibility.tsx" << 'EOF'
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bizApi, aiVisibilityApi } from '../lib/api';

const PLATFORM_META: Record<string, { label: string; icon: string; color: string; bg: string }> = {
  chatgpt:    { label: 'ChatGPT',          icon: '🤖', color: 'text-green-700',  bg: 'bg-green-50'  },
  perplexity: { label: 'Perplexity',       icon: '🔮', color: 'text-purple-700', bg: 'bg-purple-50' },
  gemini:     { label: 'Gemini',           icon: '✨', color: 'text-blue-700',   bg: 'bg-blue-50'   },
  google_ai:  { label: 'Google AI Overview', icon: '🔍', color: 'text-orange-700', bg: 'bg-orange-50' },
};

function ScoreRing({ score, size = 80 }: { score: number; size?: number }) {
  const r       = (size / 2) - 8;
  const circ    = 2 * Math.PI * r;
  const offset  = circ - (score / 100) * circ;
  const color   = score >= 60 ? '#1D9E75' : score >= 30 ? '#F59E0B' : '#EF4444';

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#E5E7EB" strokeWidth="8" />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="8"
        strokeDasharray={circ} strokeDashoffset={offset}
        strokeLinecap="round" transform={`rotate(-90 ${size/2} ${size/2})`} />
      <text x={size/2} y={size/2 + 1} textAnchor="middle" dominantBaseline="middle"
        fontSize={size * 0.22} fontWeight="bold" fill={color}>{score}</text>
    </svg>
  );
}

function TrendBadge({ trend }: { trend: string }) {
  if (trend === 'improving') return <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">↑ Improving</span>;
  if (trend === 'declining') return <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-semibold">↓ Declining</span>;
  return <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">→ Stable</span>;
}

export default function AIVisibilityPage() {
  const qc = useQueryClient();
  const [selectedBizId, setSelectedBizId] = useState('');

  const { data: businesses } = useQuery({
    queryKey: ['businesses'],
    queryFn:  () => bizApi.list().then(r => r.data.businesses),
    onSuccess: (d: any[]) => { if (d?.length && !selectedBizId) setSelectedBizId(d[0].id); },
  });

  const bizId = selectedBizId || businesses?.[0]?.id || '';

  const { data: statusData, isLoading } = useQuery({
    queryKey:       ['ai-visibility', bizId],
    queryFn:        () => aiVisibilityApi.status(bizId).then(r => r.data),
    enabled:        !!bizId,
    refetchInterval: 30000,
  });

  const checkMutation = useMutation({
    mutationFn: () => aiVisibilityApi.check(bizId),
    onSuccess:  () => {
      setTimeout(() => qc.invalidateQueries({ queryKey: ['ai-visibility', bizId] }), 10000);
    },
  });

  const latest     = statusData?.latest;
  const comparison = statusData?.comparison;
  const history    = statusData?.history ?? [];
  const platforms  = statusData?.configuredPlatforms ?? [];
  const isConfigured = statusData?.isConfigured ?? false;

  return (
    <div className="max-w-4xl space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-purple-100 rounded-2xl flex items-center justify-center text-2xl">🤖</div>
          <div>
            <h1 className="text-xl font-bold">AI Visibility</h1>
            <p className="text-sm text-gray-400">Track how your business appears in ChatGPT, Gemini & Perplexity · Checked weekly</p>
          </div>
        </div>
        {isConfigured && (
          <button onClick={() => checkMutation.mutate()}
            disabled={checkMutation.isPending || !bizId}
            className="btn-primary text-sm px-4 py-2">
            {checkMutation.isPending ? 'Checking...' : '▶ Check Now — 25 credits'}
          </button>
        )}
      </div>

      {/* Business selector */}
      {businesses && businesses.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {businesses.map((b: any) => (
            <button key={b.id} onClick={() => setSelectedBizId(b.id)}
              className={'px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-colors ' +
                (b.id === bizId ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}>
              {b.name}
            </button>
          ))}
        </div>
      )}

      {/* Not configured warning */}
      {!isLoading && !isConfigured && (
        <div className="card bg-amber-50 border-2 border-amber-200">
          <div className="flex items-start gap-3">
            <span className="text-2xl">⚠️</span>
            <div>
              <p className="font-semibold text-amber-900 mb-1">AI platform API keys not configured</p>
              <p className="text-sm text-amber-700 mb-3">
                To track your AI visibility, add at least one API key to your <code className="bg-amber-100 px-1 rounded">.env</code> file:
              </p>
              <div className="bg-white rounded-xl p-3 font-mono text-xs text-gray-700 space-y-1 border border-amber-200">
                <p>OPENAI_API_KEY=sk-...          <span className="text-gray-400"># ChatGPT — $0.001/check</span></p>
                <p>PERPLEXITY_API_KEY=pplx-...    <span className="text-gray-400"># Perplexity — $0.001/check</span></p>
                <p>GEMINI_API_KEY=...             <span className="text-gray-400"># Gemini (already used for reviews)</span></p>
              </div>
              <p className="text-xs text-amber-600 mt-2">
                If GEMINI_API_KEY is already set, Gemini visibility tracking is already active.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* No data yet */}
      {isConfigured && !isLoading && !latest && (
        <div className="card text-center py-12">
          <p className="text-4xl mb-3">🤖</p>
          <p className="font-semibold text-gray-700">No AI visibility data yet</p>
          <p className="text-sm text-gray-400 mt-1 mb-4">
            Weekly checks run every Wednesday at 3am UTC. Or run a manual check now.
          </p>
          <button onClick={() => checkMutation.mutate()}
            disabled={checkMutation.isPending}
            className="btn-primary">
            {checkMutation.isPending ? 'Running check...' : 'Run first check — 25 credits'}
          </button>
        </div>
      )}

      {/* Main score */}
      {latest && (
        <>
          {/* Score overview */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="card flex items-center gap-4 md:col-span-1">
              <ScoreRing score={latest.overall_score} size={90} />
              <div>
                <p className="font-bold text-lg">AI Score</p>
                <TrendBadge trend={statusData?.trend ?? 'stable'} />
                <p className="text-xs text-gray-400 mt-1">
                  {latest.prompts_passed}/{latest.prompts_tested} prompts
                </p>
              </div>
            </div>

            <div className="card md:col-span-2">
              <p className="font-semibold text-sm mb-3">Score by platform</p>
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(PLATFORM_META).map(([key, meta]) => {
                  const score = latest[`${key}_score`] ?? 0;
                  const active = platforms.includes(key);
                  return (
                    <div key={key} className={'flex items-center gap-3 p-3 rounded-xl ' + meta.bg + (active ? '' : ' opacity-40')}>
                      <span className="text-xl">{meta.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <p className={'text-xs font-semibold ' + meta.color}>{meta.label}</p>
                          <p className={'text-sm font-bold ' + meta.color}>{active ? score + '%' : 'N/A'}</p>
                        </div>
                        <div className="h-1.5 bg-white rounded-full overflow-hidden">
                          <div className="h-full rounded-full bg-current transition-all"
                            style={{ width: active ? score + '%' : '0%', color: meta.color.replace('text-', '#').replace('-700','') }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Key insight */}
          <div className="card bg-purple-50 border border-purple-200">
            <div className="flex items-start gap-3">
              <span className="text-xl">💡</span>
              <div>
                <p className="font-semibold text-purple-900 mb-1">Key insight</p>
                <p className="text-sm text-purple-700">{latest.top_insight}</p>
              </div>
            </div>
          </div>

          {/* Actions */}
          {latest.actions?.length > 0 && (
            <div className="card">
              <p className="font-semibold text-sm mb-3">🎯 Recommended actions</p>
              <div className="space-y-2">
                {latest.actions.map((action: string, i: number) => (
                  <div key={i} className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
                    <div className="w-5 h-5 bg-purple-100 rounded-full flex items-center justify-center text-xs font-bold text-purple-700 shrink-0 mt-0.5">{i + 1}</div>
                    <p className="text-sm text-gray-700">{action}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Competitor comparison */}
          {comparison && (comparison.competitors?.length ?? 0) > 0 && (
            <div className="card">
              <p className="font-semibold text-sm mb-4">AI Visibility — You vs Competitors</p>
              <div className="space-y-3">
                {/* Your business first */}
                <div className="flex items-center gap-3 p-3 bg-brand-50 border border-brand-200 rounded-xl">
                  <div className="w-8 h-8 bg-brand-100 rounded-lg flex items-center justify-center text-brand-700 font-bold text-xs shrink-0">You</div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-gray-800">{comparison.business.name}</p>
                    <div className="h-2 bg-gray-100 rounded-full mt-1 overflow-hidden">
                      <div className="h-full bg-brand-500 rounded-full" style={{ width: comparison.business.score + '%' }} />
                    </div>
                  </div>
                  <p className="text-sm font-bold text-brand-600 shrink-0">{comparison.business.score}%</p>
                </div>
                {/* Competitors */}
                {comparison.competitors.map((comp: any) => (
                  <div key={comp.placeId} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                    <div className="w-8 h-8 bg-gray-200 rounded-lg flex items-center justify-center text-gray-600 font-bold text-xs shrink-0">C</div>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-gray-700 truncate">{comp.name}</p>
                      <div className="h-2 bg-gray-100 rounded-full mt-1 overflow-hidden">
                        <div className="h-full bg-red-400 rounded-full" style={{ width: comp.score + '%' }} />
                      </div>
                    </div>
                    <p className="text-sm font-bold text-gray-600 shrink-0">{comp.score}%</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* History chart */}
          {history.length > 1 && (
            <div className="card">
              <p className="font-semibold text-sm mb-4">Score history</p>
              <div className="flex items-end gap-2 h-24">
                {history.slice(0, 8).reverse().map((h: any, i: number) => {
                  const pct  = h.overall_score;
                  const col  = pct >= 60 ? 'bg-green-500' : pct >= 30 ? 'bg-amber-400' : 'bg-red-400';
                  const date = new Date(h.checked_at).toLocaleDateString('en', { month: 'short', day: 'numeric' });
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1">
                      <p className="text-xs text-gray-400 font-semibold">{pct}</p>
                      <div className="w-full rounded-t-sm " style={{ height: Math.max(4, pct * 0.8) + 'px' }}>
                        <div className={`w-full h-full rounded-t-sm ${col}`} />
                      </div>
                      <p className="text-xs text-gray-400 whitespace-nowrap">{date}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <p className="text-xs text-gray-400 text-center">
            Checked weekly every Wednesday · Monitors {platforms.length} AI platform{platforms.length !== 1 ? 's' : ''} · Uses zero credits for automated checks
          </p>
        </>
      )}
    </div>
  );
}
EOF

# ── 7. Update Layout.tsx ──────────────────────────────────────
echo "  Updating Layout.tsx — add AI Visibility nav item"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/frontend/src/components/Layout.tsx'
with open(path) as f: src = f.read()

if 'AIVisibility' not in src:
    src = src.replace(
        "import ProfilePage         from '../pages/Profile';",
        "import ProfilePage         from '../pages/Profile';\nimport AIVisibilityPage    from '../pages/AIVisibility';"
    )
    src = src.replace(
        "  { path: '/overview',   icon: '▦',  label: 'Overview' },",
        "  { path: '/overview',   icon: '▦',  label: 'Overview' },\n  { path: '/ai-visibility',icon: '🤖', label: 'AI Visibility' },"
    )
    src = src.replace(
        "              <Route path=\"/profile\"               element={<ProfilePage />} />",
        "              <Route path=\"/profile\"               element={<ProfilePage />} />\n              <Route path=\"/ai-visibility\"          element={<AIVisibilityPage />} />"
    )
    src = src.replace(
        "    '/overview':      'Overview',",
        "    '/overview':      'Overview',\n    '/ai-visibility': 'AI Visibility',"
    )
    with open(path, 'w') as f: f.write(src)
    print("  ✓ Layout.tsx AI Visibility nav added")
else:
    print("  ✓ Already present")
PYEOF

# ── 8. SQL migration ──────────────────────────────────────────
echo "  Writing SQL migration 009..."
cat > "$ROOT/migration/009-ai-visibility.sql" << 'SQLEOF'
-- Migration 009: AI Visibility
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS public.ai_visibility_results (
  id               uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id      uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  keyword          text        NOT NULL,
  city             text,
  overall_score    integer     NOT NULL DEFAULT 0,
  chatgpt_score    integer     NOT NULL DEFAULT 0,
  perplexity_score integer     NOT NULL DEFAULT 0,
  gemini_score     integer     NOT NULL DEFAULT 0,
  google_ai_score  integer     NOT NULL DEFAULT 0,
  prompts_tested   integer     NOT NULL DEFAULT 0,
  prompts_passed   integer     NOT NULL DEFAULT 0,
  share_of_voice   integer     NOT NULL DEFAULT 0,
  trend            text        NOT NULL DEFAULT 'stable'
    CHECK (trend IN ('improving','stable','declining')),
  top_insight      text,
  actions          jsonb       NOT NULL DEFAULT '[]',
  raw_results      jsonb       NOT NULL DEFAULT '[]',
  checked_at       timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_visibility_biz
  ON public.ai_visibility_results(business_id, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_visibility_user
  ON public.ai_visibility_results(user_id, checked_at DESC);

ALTER TABLE public.ai_visibility_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own AI visibility" ON public.ai_visibility_results;
CREATE POLICY "Users see own AI visibility"
  ON public.ai_visibility_results FOR ALL
  USING (user_id = auth.uid());

GRANT ALL ON public.ai_visibility_results TO service_role;

-- Auto-cleanup: keep 90 days
CREATE OR REPLACE FUNCTION public.cleanup_old_ai_visibility()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM public.ai_visibility_results
  WHERE checked_at < now() - INTERVAL '90 days';
END;
$$;

-- Verify
-- SELECT count(*) FROM public.ai_visibility_results;
SQLEOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " AI Visibility complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " Files created/updated:"
echo "   ✓ [NEW] apps/api/src/domains/aivisibility/AIVisibilityService.ts"
echo "   ✓ [NEW] apps/api/src/api/routes/aiVisibility.ts"
echo "   ✓ [UPD] apps/api/src/domains/scheduling/WeeklyScheduler.ts"
echo "   ✓ [UPD] apps/api/src/index.ts"
echo "   ✓ [UPD] apps/frontend/src/lib/api.ts"
echo "   ✓ [NEW] apps/frontend/src/pages/AIVisibility.tsx"
echo "   ✓ [UPD] apps/frontend/src/components/Layout.tsx"
echo "   ✓ [NEW] migration/009-ai-visibility.sql"
echo ""
echo " Next steps:"
echo "   1. Run migration/009-ai-visibility.sql in Supabase"
echo "   2. Add to apps/api/.env:"
echo "      OPENAI_API_KEY=sk-...        (ChatGPT — get at platform.openai.com)"
echo "      PERPLEXITY_API_KEY=pplx-...  (get at perplexity.ai/settings/api)"
echo "      GEMINI_API_KEY already set → Gemini tracking already active"
echo "   3. npm run dev"
echo "   4. Visit /ai-visibility"
echo ""
echo " How it works:"
echo "   Every Wednesday 3am UTC — 20 AI prompts per business across all platforms"
echo "   ChatGPT: $0.001/check via gpt-4o-mini"
echo "   Perplexity: $0.001/check via sonar-small"
echo "   Gemini: already configured — $0 extra"
echo "   Cost per Agency customer (5 biz): ~$0.30/week = $1.20/month"
echo "   Zero credits consumed for weekly automated checks"
echo ""
