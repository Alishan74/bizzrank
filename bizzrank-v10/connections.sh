#!/usr/bin/env bash
# BizzRank AI — Four Cross-Feature Connections
# 1. GBP Guard   → Overview (alert insight cards)
# 2. AI Visibility → Overview (score insight card)
# 3. Review Intel → Review Replies (themes injected into Gemini prompt)
# 4. Citation Intel → GBP Guard (website/address change triggers re-check)
# cd /workspaces/bizzrank/bizzrank-v10 && bash connections.sh
set -e
ROOT="$(pwd)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " BizzRank AI — Four Cross-Feature Connections"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─────────────────────────────────────────────────────────────
# CONNECTION 1: GBP Guard + AI Visibility → dashboard.ts
#
# WHY: The dashboard is the only page that loads automatically.
# Critical GBP Guard alerts and a low AI Visibility score both
# need to be surfaced here so customers see them without having
# to navigate to /gbp-guard or /ai-visibility.
#
# WHAT: Add gbpGuard + aiVisibility data to the dashboard
# response so Overview.tsx can build insight cards from them.
# Zero new API calls — reads from DB tables already populated
# by the existing daily/weekly cron jobs.
# ─────────────────────────────────────────────────────────────
echo "  [1/4] dashboard.ts — add GBP Guard + AI Visibility to response"
cat > "$ROOT/apps/api/src/api/routes/dashboard.ts" << 'EOF'
/**
 * Dashboard Route — single API call that powers the Overview page.
 *
 * Connections wired here:
 *   - GBP Guard summary (unread alert count + critical count)
 *     → Overview renders GBP Guard insight cards
 *   - AI Visibility latest score for primary business
 *     → Overview renders AI Visibility insight card when score is low
 *
 * ALL queries run in parallel — single round-trip to Supabase.
 * Zero new API calls — reads from tables already populated by crons.
 */
import { Router } from 'express';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { getPlan } from '../../domains/billing/BillingService.js';
import { getCacheConfidence, getIntelLevel } from '../../infrastructure/cache/CacheService.js';
import { intelligenceService } from '../../domains/intelligence/IntelligenceService.js';
import { gbpGuardService } from '../../domains/gbpguard/GBPGuardService.js';

const router = Router();

router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const uid = req.userId!;

  // All parallel — single round trip to Supabase
  const [
    { data: profile },
    { data: activeOrganicScans },
    { data: activeAdSessions },
    { data: latestScores },
    { data: businesses },
    { data: recentScans },
  ] = await Promise.all([
    db.from('profiles').select('*').eq('id', uid).single(),
    db.from('organic_scans')
      .select('id, keyword, state, business_id, total_points, points_completed, created_at')
      .eq('user_id', uid)
      .in('state', ['pending', 'running'])
      .order('created_at', { ascending: false }),
    db.from('ad_scan_sessions')
      .select('*, ad_scan_slots(id, slot_time, state, pressure_score)')
      .eq('user_id', uid)
      .in('state', ['scheduled', 'running'])
      .order('created_at', { ascending: false }),
    db.from('organic_scores')
      .select('*')
      .eq('user_id', uid)
      .order('scanned_at', { ascending: false })
      .limit(5),
    db.from('businesses')
      .select('id, name, latitude, longitude, google_place_id')
      .eq('user_id', uid)
      .eq('is_active', true),
    db.from('organic_scans')
      .select('id, keyword, state, targeting_method, total_points, points_completed, created_at, organic_scores(organic_visibility_score)')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(8),
  ]);

  const plan       = profile?.plan ?? 'starter';
  const planConfig = getPlan(plan);

  // Secondary data for primary business — all parallel, all zero new API calls
  let intelLevel      = null;
  let cacheConfidence = null;
  let opportunityScore = null;
  let gbpGuard        = null;
  let aiVisibility    = null;

  if (businesses?.length) {
    const primaryBizId = businesses[0].id;

    [intelLevel, cacheConfidence, opportunityScore, gbpGuard, aiVisibility] = await Promise.all([
      getIntelLevel(uid),
      getCacheConfidence(primaryBizId),
      intelligenceService.computeOpportunityScore(primaryBizId, uid),

      // GBP Guard summary — unread + critical alert counts
      // Powers the GBP Guard insight cards in Overview
      gbpGuardService.getGuardSummary(uid).catch(() => null),

      // AI Visibility — latest score for primary business
      // Powers the AI Visibility insight card in Overview
      db.from('ai_visibility_results')
        .select('overall_score, discovery_score, sentiment_score, trend, trend_delta, top_insight, checked_at')
        .eq('business_id', primaryBizId)
        .eq('user_id', uid)
        .order('checked_at', { ascending: false })
        .limit(1)
        .single()
        .then(({ data }) => data ?? null)
        .catch(() => null),
    ]);
  }

  res.json({
    profile,
    planConfig,
    planFeatures: {
      hasAiReplies:          planConfig.hasAiReplies,
      hasAutoPost:           planConfig.hasAutoPost,
      hasAdPressure:         planConfig.hasAdPressure,
      hasCitations:          planConfig.hasCitations,
      hasReviewIntelligence: planConfig.hasReviewIntelligence,
      hasL3Reports:          planConfig.hasL3Reports,
    },
    activeOrganicScans:  activeOrganicScans  ?? [],
    activeAdSessions:    activeAdSessions    ?? [],
    latestScores:        latestScores        ?? [],
    businesses:          businesses          ?? [],
    recentScans:         recentScans         ?? [],
    hasActiveScans:      (activeOrganicScans?.length ?? 0) > 0 || (activeAdSessions?.length ?? 0) > 0,
    intelligence: {
      level:       intelLevel    ?? { level: 0, reason: 'Monitoring active' },
      confidence:  cacheConfidence ?? { score: 100, changesDetected: false },
      opportunity: opportunityScore,
    },
    // ── NEW: GBP Guard summary for Overview insight cards ────
    gbpGuard: gbpGuard ? {
      totalUnread:     gbpGuard.totalUnread,
      criticalUnread:  gbpGuard.criticalUnread,
      lastChecked:     gbpGuard.lastChecked,
      alertsLast7Days: gbpGuard.alertsLast7Days,
    } : null,
    // ── NEW: AI Visibility latest score for Overview insight card ─
    aiVisibility: aiVisibility ? {
      overallScore:   aiVisibility.overall_score,
      discoveryScore: aiVisibility.discovery_score ?? 0,
      sentimentScore: aiVisibility.sentiment_score ?? 0,
      trend:          aiVisibility.trend,
      trendDelta:     aiVisibility.trend_delta ?? 0,
      topInsight:     aiVisibility.top_insight,
      checkedAt:      aiVisibility.checked_at,
    } : null,
    pollIntervalMs: 60000,
  });
});

export default router;
EOF

# ─────────────────────────────────────────────────────────────
# CONNECTION 2: GBP Guard + AI Visibility + AdPressure → Overview
#
# WHY: buildInsights() handles RankingDelta, VisibilityDelta,
# CompetitorDelta, ReviewDelta — but NOT:
#   - AdPressureDelta (signal fires, never shown)
#   - GBP Guard alerts (never surfaced at all on Overview)
#   - AI Visibility score (tracked weekly, invisible on Overview)
#
# WHAT: Add three new insight categories to buildInsights():
#   1. AdPressureDelta signal → "Competitor ad spend spiked X%"
#   2. GBP Guard critical alerts → "Your address was changed"
#   3. AI Visibility low score → "You appear in X% of AI searches"
#
# HOW: All data is already in the dashboard response after Fix 1.
# buildInsights() just needs to read data.gbpGuard + data.aiVisibility
# in addition to the signals it already processes.
# ─────────────────────────────────────────────────────────────
echo "  [2/4] Overview.tsx — add GBP Guard + AI Visibility + AdPressure insights"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/frontend/src/pages/Overview.tsx'
with open(path) as f: src = f.read()

# ── Step A: extend buildInsights signature to accept gbpGuard + aiVisibility ──
old_sig = "function buildInsights(data: any, businesses: any[], latestScores: any[], signals: any[]): Insight[] {"
new_sig = """function buildInsights(
  data:        any,
  businesses:  any[],
  latestScores: any[],
  signals:     any[],
): Insight[] {
  // Also reads data.gbpGuard and data.aiVisibility directly
  // These are included in the dashboard response and power
  // the GBP Guard and AI Visibility insight cards"""
src = src.replace(old_sig, new_sig)

# ── Step B: add AdPressureDelta + GBP Guard + AI Visibility handling ──
# Insert AFTER the last signal handler (ReviewDelta block) and BEFORE the
# "No data fallback" comment. Find the exact end of the signals loop.

old_no_data = "  // No data fallback\n  if (insights.length === 0) {"
new_before_fallback = """  // ── AdPressureDelta signal — ad spend spike in your area ──────
  // Previously: this signal was saved to intel_signals but never
  // displayed anywhere. Customers had no idea when competitor ad
  // spend spiked in their service area.
  for (const s of signals.filter((x: any) => x.signal_type === 'AdPressureDelta').slice(0, 2)) {
    const biz = businesses.find((b: any) => b.id === s.business_id) ?? { name: 'Your Business' };
    insights.push({
      id:           'sig-ad-' + s.id,
      icon:         '📢',
      type:         'alert',
      businessName: biz.name,
      keyword:      s.keyword ?? '',
      headline:     `Competitor ad spend spiked ${Math.round(s.value)}% this week`,
      detail:       `${biz.name}'s service area saw a ${Math.round(s.value)}% increase in Google Ads activity. Competitors are investing more in paid placements — your organic position matters more now.`,
      reason:       'Ad pressure spikes mean competitors are paying to appear above organic results. Strong organic rankings are your defence — customers who scroll past ads trust organic results more.',
      action:       'View ad pressure →',
      actionPath:   '/ad-insights',
    });
  }

  // ── GBP Guard alerts — critical profile changes ─────────────
  // Previously: GBP Guard ran daily and detected changes, but
  // customers only saw alerts if they navigated to /gbp-guard.
  // Critical alerts (address changed, permanently closed) now
  // surface directly in the Overview feed.
  const gbp = data?.gbpGuard;
  if (gbp?.criticalUnread > 0) {
    const firstBiz = businesses[0] ?? { name: 'Your Business' };
    insights.push({
      id:           'gbp-critical',
      icon:         '🚨',
      type:         'alert',
      businessName: firstBiz.name,
      keyword:      '',
      headline:     `${gbp.criticalUnread} critical GBP change${gbp.criticalUnread > 1 ? 's' : ''} detected`,
      detail:       `Your Google Business Profile has ${gbp.criticalUnread} critical change${gbp.criticalUnread > 1 ? 's' : ''} that need immediate attention. This could be an unauthorized edit to your address, phone number, or category.`,
      reason:       'Anyone can suggest edits to a Google Business Profile. Unauthorized changes to your address or category directly harm your local search rankings and can send customers to the wrong location.',
      action:       'Review changes →',
      actionPath:   '/gbp-guard',
    });
  } else if (gbp?.totalUnread > 0) {
    const firstBiz = businesses[0] ?? { name: 'Your Business' };
    insights.push({
      id:           'gbp-unread',
      icon:         '🛡️',
      type:         'info',
      businessName: firstBiz.name,
      keyword:      '',
      headline:     `${gbp.totalUnread} GBP update${gbp.totalUnread > 1 ? 's' : ''} detected`,
      detail:       `${gbp.totalUnread} change${gbp.totalUnread > 1 ? 's were' : ' was'} detected on your Google Business Profile in the last 7 days. Review them to confirm they're authorised.`,
      reason:       'Regular profile changes like hours updates are normal, but any change to your address, phone, or category should be verified.',
      action:       'Review changes →',
      actionPath:   '/gbp-guard',
    });
  }

  // ── AI Visibility score — how you appear in AI searches ─────
  // Previously: AI Visibility was tracked weekly but the score
  // was completely invisible unless the customer visited /ai-visibility.
  // Now surfaces as an insight when the score is low, declining,
  // or when it's the first time a score exists (first check done).
  const aiv = data?.aiVisibility;
  if (aiv) {
    const firstBiz = businesses[0] ?? { name: 'Your Business' };
    const score    = aiv.overallScore ?? 0;
    const disc     = aiv.discoveryScore ?? 0;

    if (aiv.trend === 'improving' && (aiv.trendDelta ?? 0) >= 10) {
      insights.push({
        id:           'aiv-improving',
        icon:         '🤖',
        type:         'win',
        businessName: firstBiz.name,
        keyword:      '',
        headline:     `AI visibility improving — up ${aiv.trendDelta} points`,
        detail:       `${firstBiz.name}'s AI visibility score rose by ${aiv.trendDelta} points to ${score}/100. More customers asking ChatGPT, Gemini, or Perplexity for recommendations in your area are now finding you.`,
        reason:       'AI visibility improves when your Foursquare/Yelp listings are complete, your GBP description contains location keywords, and your reviews mention your specific services.',
        action:       'View AI visibility →',
        actionPath:   '/ai-visibility',
      });
    } else if (score < 20) {
      insights.push({
        id:           'aiv-low',
        icon:         '🤖',
        type:         'alert',
        businessName: firstBiz.name,
        keyword:      '',
        headline:     `Low AI visibility — appearing in ${score}% of AI searches`,
        detail:       `When someone asks ChatGPT or Google AI "best ${firstBiz.name?.split(' ')[0] ?? 'business'} near me", ${firstBiz.name} appears in only ${score}% of AI recommendations. ${disc < 20 ? 'Your discovery score is ' + disc + '% — new customers rarely find you through AI.' : ''}`,
        reason:       aiv.topInsight ?? 'AI platforms like ChatGPT use Foursquare as their primary local data source. Claiming your Foursquare listing is the highest-impact single action.',
        action:       'Improve AI visibility →',
        actionPath:   '/ai-visibility',
      });
    } else if (score < 50) {
      insights.push({
        id:           'aiv-medium',
        icon:         '🤖',
        type:         'tip',
        businessName: firstBiz.name,
        keyword:      '',
        headline:     `AI visibility at ${score}% — room to grow`,
        detail:       `${firstBiz.name} appears in ${score}% of AI recommendation queries. Discovery score: ${disc}% — this is the score that drives new customers who don't already know you.`,
        reason:       aiv.topInsight ?? 'Strengthen your Foursquare, Yelp, and Healthgrades listings to improve AI recommendation rates across all platforms.',
        action:       'View AI visibility →',
        actionPath:   '/ai-visibility',
      });
    } else if (aiv.trend === 'declining') {
      insights.push({
        id:           'aiv-declining',
        icon:         '🤖',
        type:         'alert',
        businessName: firstBiz.name,
        keyword:      '',
        headline:     `AI visibility declining — down ${Math.abs(aiv.trendDelta ?? 0)} points`,
        detail:       `${firstBiz.name}'s AI visibility dropped from ${score + Math.abs(aiv.trendDelta ?? 0)} to ${score}/100. You're appearing in fewer AI searches than last week.`,
        reason:       'AI visibility can decline when competitors improve their listings, when your review response rate drops, or when your GBP information becomes inconsistent.',
        action:       'View AI visibility →',
        actionPath:   '/ai-visibility',
      });
    }
  }

  // No data fallback
  if (insights.length === 0) {"""

src = src.replace(old_no_data, new_before_fallback)

with open(path, 'w') as f: f.write(src)
print("  ✓ Overview.tsx — GBP Guard + AI Visibility + AdPressure insights added")
PYEOF

# ─────────────────────────────────────────────────────────────
# CONNECTION 3: Review Intelligence → Review Replies
#
# WHY: ReviewIntelligenceService identifies recurring negative
# themes (e.g. "Slow Service", "Long Wait", "Parking Issues")
# by analysing all reviews with Gemini. These themes are stored
# in review_intelligence.negative_themes. But when GeminiService
# generates a reply, it knows nothing about these themes —
# every reply is generated with zero context about known issues.
#
# A reply to "waited 45 minutes" that ignores the fact that slow
# service is a known recurring complaint sounds tone-deaf.
# A reply that acknowledges "we know wait times have been an
# issue and here's what we're doing about it" is far better.
#
# WHAT:
#   1. Add knownIssues?: string[] to ReviewContext interface
#   2. Inject themes into the Gemini prompt when rating <= 3
#      (negative + neutral reviews benefit most from context)
#   3. Load cached review intelligence in runBatchGeneration()
#      before generating replies — zero extra API calls
#      (getCached() reads from DB, never calls Gemini again)
# ─────────────────────────────────────────────────────────────
echo "  [3/4] GeminiService.ts + ReviewService.ts — inject review intel themes"

python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
gemini_path = root + '/apps/api/src/domains/reviews/GeminiService.ts'
with open(gemini_path) as f: src = f.read()

# Add knownIssues field to ReviewContext interface
old_interface = """export interface ReviewContext {
  reviewerName: string;
  rating: number;
  reviewText: string;
  businessName: string;
  brandVoice: BrandVoice;
  existingReplies?: string[];
}"""

new_interface = """export interface ReviewContext {
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
}"""

src = src.replace(old_interface, new_interface)

# Inject knownIssues into the Gemini prompt
# Only for negative and neutral reviews (rating <= 3) — positive
# reviews don't need acknowledgement of recurring issues
old_prompt_build = """  const ratingGuidance = rating <= 2
    ? `${rating}-star NEGATIVE review. Respond with genuine empathy. Do NOT be defensive. Acknowledge their concern. Offer to resolve privately.`
    : rating === 3
    ? `3-star NEUTRAL review. Acknowledge what went well, address what could be better.`
    : `${rating}-star POSITIVE review. Respond warmly and specifically — reference something from their actual review.`;

  const prompt = `You are ${brandVoice.ownerName ?? 'the business owner'} of "${businessName}".
Tone: ${TONE_GUIDE[brandVoice.tone] ?? TONE_GUIDE.friendly}
${brandVoice.emphasize ? `Always emphasize: ${brandVoice.emphasize}` : ''}
${brandVoice.avoid ? `Always avoid: ${brandVoice.avoid}` : ''}
${brandVoice.exampleReply ? `Learn style from this example (do NOT copy): "${brandVoice.exampleReply}"` : ''}

${ratingGuidance}

RULES: Never start with "Thank you for your review". Never use "valued customer". Never include phone numbers, URLs or discounts. Keep 3-4 sentences. Reference something specific from the review.

Reviewer: ${reviewerName}
Rating: ${rating}/5
Review: "${reviewText || '(Star rating only — no written text)'}"

Write ONE reply only. No quotes. No preamble. Just the reply text.`;"""

new_prompt_build = """  const ratingGuidance = rating <= 2
    ? `${rating}-star NEGATIVE review. Respond with genuine empathy. Do NOT be defensive. Acknowledge their concern. Offer to resolve privately.`
    : rating === 3
    ? `3-star NEUTRAL review. Acknowledge what went well, address what could be better.`
    : `${rating}-star POSITIVE review. Respond warmly and specifically — reference something from their actual review.`;

  // Inject known recurring issues for negative/neutral reviews only.
  // For positive reviews this context is irrelevant and would make replies odd.
  // knownIssues comes from ReviewIntelligenceService.getCached() — zero extra cost.
  const issuesContext = (ctx.knownIssues?.length && rating <= 3)
    ? `\\nKNOWN RECURRING ISSUES customers mention: ${ctx.knownIssues.slice(0, 3).join(', ')}.`
      + `\\nIf this review mentions any of these, acknowledge them specifically and show awareness that you're working to improve. Don't be defensive.`
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

Write ONE reply only. No quotes. No preamble. Just the reply text.`;"""

src = src.replace(old_prompt_build, new_prompt_build)

with open(gemini_path, 'w') as f: f.write(src)
print("  ✓ GeminiService.ts — knownIssues added to ReviewContext + prompt")
PYEOF

# Now update ReviewService.ts to load review intelligence before batch generation
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/domains/reviews/ReviewService.ts'
with open(path) as f: src = f.read()

# Add import for ReviewIntelligenceService
if 'reviewIntelligenceService' not in src:
    src = src.replace(
        "import { generateReviewReply, generateBatchReplies, estimateRevenueLost } from './GeminiService.js';",
        "import { generateReviewReply, generateBatchReplies, estimateRevenueLost } from './GeminiService.js';\nimport { reviewIntelligenceService } from './ReviewIntelligenceService.js';"
    )

# Replace runBatchGeneration to load review intel themes first
old_batch = """  private async runBatchGeneration(reviews: any[], businessName: string, brandVoice: any) {
    const results = await generateBatchReplies(
      reviews.map(r => ({
        id: r.id, reviewerName: r.reviewer_name ?? 'there',
        rating: r.rating, reviewText: r.review_text ?? '',
      })),
      businessName, brandVoice,
    );"""

new_batch = """  private async runBatchGeneration(reviews: any[], businessName: string, brandVoice: any, businessId?: string) {
    // Load cached review intelligence to extract known negative themes.
    // getCached() reads from the review_intelligence DB table — zero Gemini API calls.
    // This is the connection: ReviewIntelligence → ReviewReplies.
    // Themes are only injected for negative/neutral reviews (rating <= 3) — see GeminiService.
    let knownIssues: string[] = [];
    if (businessId) {
      try {
        const intel = await reviewIntelligenceService.getCachedThemes(businessId);
        knownIssues = intel ?? [];
      } catch { /* non-critical — reply generation continues without themes */ }
    }

    const results = await generateBatchReplies(
      reviews.map(r => ({
        id: r.id, reviewerName: r.reviewer_name ?? 'there',
        rating: r.rating, reviewText: r.review_text ?? '',
        // knownIssues injected here — passed through to GeminiService.generateReviewReply()
        knownIssues,
      })),
      businessName, brandVoice,
    );"""

src = src.replace(old_batch, new_batch)

# Also pass businessId when calling runBatchGeneration
old_call = "    this.runBatchGeneration(reviews, biz?.name ?? 'our business', brandVoice).catch(console.error);"
new_call = "    this.runBatchGeneration(reviews, biz?.name ?? 'our business', brandVoice, businessId).catch(console.error);"
src = src.replace(old_call, new_call)

with open(path, 'w') as f: f.write(src)
print("  ✓ ReviewService.ts — runBatchGeneration loads review intel themes")
PYEOF

# Add getCachedThemes() to ReviewIntelligenceService
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/domains/reviews/ReviewIntelligenceService.ts'
with open(path) as f: src = f.read()

# Add a lightweight getCachedThemes() method that returns just negative theme names
# This is what ReviewService calls — no Gemini, no analysis, pure DB read
if 'getCachedThemes' not in src:
    old_weekly = "  /**\n   * Weekly refresh for all businesses with enough reviews."
    new_method = """  /**
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
   * Weekly refresh for all businesses with enough reviews."""

    src = src.replace(old_weekly, new_method)
    with open(path, 'w') as f: f.write(src)
    print("  ✓ ReviewIntelligenceService.ts — getCachedThemes() added")
else:
    print("  ✓ ReviewIntelligenceService.ts — getCachedThemes() already present")
PYEOF

# Also update generateBatchReplies in GeminiService to pass knownIssues through
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/domains/reviews/GeminiService.ts'
with open(path) as f: src = f.read()

# Update generateBatchReplies to accept and pass through knownIssues
old_batch_sig = """export async function generateBatchReplies(
  reviews: Array<{ id: string; reviewerName: string; rating: number; reviewText: string }>,
  businessName: string,
  brandVoice: BrandVoice
): Promise<Array<{ reviewId: string; reply: string; error?: string }>> {
  const results = [];
  for (const review of reviews) {
    try {
      const reply = await generateReviewReply({ reviewerName: review.reviewerName, rating: review.rating, reviewText: review.reviewText, businessName, brandVoice });"""

new_batch_sig = """export async function generateBatchReplies(
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
      });"""

src = src.replace(old_batch_sig, new_batch_sig)
with open(path, 'w') as f: f.write(src)
print("  ✓ GeminiService.ts generateBatchReplies — knownIssues wired through")
PYEOF

# ─────────────────────────────────────────────────────────────
# CONNECTION 4: Citation Intelligence → GBP Guard
#
# WHY: When GBP Guard detects a change to a business's website
# URL or address (the fields that directly affect citation
# consistency), it should immediately trigger an AI citation
# re-check. Citation URLs across Foursquare, Yelp, Healthgrades
# etc. now point to the OLD URL — the business will become
# invisible on Perplexity and ChatGPT until citations are updated.
#
# WHAT:
#   1. Add GBP_CHANGE_DETECTED event to EventBus
#   2. After GBPGuardService saves critical/warning alerts,
#      publish GBP_CHANGE_DETECTED with affected fields
#   3. AICitationService subscribes to this event and
#      triggers a lightweight citation re-check for the
#      fields that changed (website, address, phone)
#
# WHICH FIELDS TRIGGER A CITATION RE-CHECK:
#   - website  → Perplexity cites your website directly
#   - address  → All platforms use address for NAP consistency
#   - name     → Name changes break all citations
#   - phone    → Phone is a core NAP signal
#   Other fields (hours, description, rating) don't affect
#   citation consistency — no need to trigger re-check.
# ─────────────────────────────────────────────────────────────
echo "  [4/4] EventBus + GBPGuardService + AICitationService — citation trigger"

# Add GBP_CHANGE_DETECTED event to EventBus
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/infrastructure/events/EventBus.ts'
with open(path) as f: src = f.read()

if 'GBP_CHANGE_DETECTED' not in src:
    src = src.replace(
        "  CREDITS_DEDUCTED:       'billing.credits.deducted',\n} as const;",
        "  CREDITS_DEDUCTED:       'billing.credits.deducted',\n"
        "  // Fired by GBPGuardService when critical/warning fields change.\n"
        "  // AICitationService subscribes to trigger a citation re-check\n"
        "  // when website, address, name, or phone changes are detected.\n"
        "  GBP_CHANGE_DETECTED:    'gbp.change.detected',\n"
        "} as const;"
    )
    with open(path, 'w') as f: f.write(src)
    print("  ✓ EventBus.ts — GBP_CHANGE_DETECTED event added")
else:
    print("  ✓ EventBus.ts — already has GBP_CHANGE_DETECTED")
PYEOF

# Update GBPGuardService to publish event after saving critical/warning alerts
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/domains/gbpguard/GBPGuardService.ts'
with open(path) as f: src = f.read()

# Add eventBus import
if 'eventBus' not in src:
    src = src.replace(
        "import { serpApiService } from '../serpapi/SerpApiService.js';",
        "import { serpApiService } from '../serpapi/SerpApiService.js';\nimport { eventBus, Events } from '../../infrastructure/events/EventBus.js';"
    )

# Publish event after saving alerts — only for fields that affect citations
old_save_alerts = """    if (!alerts.length) return 0;

    // Save all alerts
    await db.from('gbp_guard_alerts').insert(alerts);
    logger.info('[GBPGuard] Alerts generated', {
      entityId, entityName, isCompetitor, count: alerts.length,
    });

    return alerts.length;"""

new_save_alerts = """    if (!alerts.length) return 0;

    // Save all alerts
    await db.from('gbp_guard_alerts').insert(alerts);
    logger.info('[GBPGuard] Alerts generated', {
      entityId, entityName, isCompetitor, count: alerts.length,
    });

    // Publish GBP_CHANGE_DETECTED for fields that affect citation consistency.
    // Only fires for YOUR business (not competitors) and only for fields that
    // directly impact how AI platforms find and cite you:
    //   website  → Perplexity cites your website — old URL breaks citations
    //   address  → All platforms use address for NAP consistency
    //   name     → Name changes break citation matching across all platforms
    //   phone    → Core NAP signal for local business data sources
    //
    // AICitationService subscribes to this event and schedules a re-check.
    const citationTriggerFields = ['website', 'address', 'name', 'phone'];
    const citationAlerts = alerts.filter(a =>
      !isCompetitor && citationTriggerFields.includes(a.field_name)
    );

    if (citationAlerts.length > 0) {
      eventBus.publish(Events.GBP_CHANGE_DETECTED, {
        entityId,
        userId,
        entityName,
        changedFields: citationAlerts.map(a => ({
          field:    a.field_name,
          oldValue: a.old_value,
          newValue: a.new_value,
        })),
        detectedAt: new Date().toISOString(),
      });
      logger.info('[GBPGuard] Citation re-check triggered', {
        entityId, fields: citationAlerts.map(a => a.field_name),
      });
    }

    return alerts.length;"""

src = src.replace(old_save_alerts, new_save_alerts)
with open(path, 'w') as f: f.write(src)
print("  ✓ GBPGuardService.ts — publishes GBP_CHANGE_DETECTED after critical alerts")
PYEOF

# Subscribe in AICitationService
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/domains/aivisibility/AICitationService.ts'
with open(path) as f: src = f.read()

# Add eventBus import and subscription at the bottom of the file
if 'GBP_CHANGE_DETECTED' not in src:
    # Add import at top
    src = src.replace(
        "import { db } from '../../infrastructure/database/SupabaseClient.js';",
        "import { db } from '../../infrastructure/database/SupabaseClient.js';\nimport { eventBus, Events } from '../../infrastructure/events/EventBus.js';"
    )

    # Add event handler before the final export line
    src = src.replace(
        "export const aiCitationService = new AICitationService();",
        """export const aiCitationService = new AICitationService();

/**
 * Subscribe to GBP_CHANGE_DETECTED events published by GBPGuardService.
 *
 * When a business's website, address, name, or phone changes, all their
 * citations across Foursquare, Yelp, Healthgrades etc. now point to old
 * information. This makes them invisible or misleading to AI platforms
 * until citations are updated.
 *
 * We schedule a lightweight citation gap analysis using the data we
 * already have — no new external API calls required. The result updates
 * the ai_citation_intelligence table which the Citations tab already reads.
 *
 * Why a 2-minute delay: GBPGuardService may be processing multiple alerts
 * for the same business in a single check run. We wait 2 minutes to batch
 * them rather than triggering a re-check for every individual field change.
 */
const pendingCitationChecks = new Map<string, ReturnType<typeof setTimeout>>();

eventBus.subscribe<{
  entityId:      string;
  userId:        string;
  entityName:    string;
  changedFields: Array<{ field: string; oldValue: string; newValue: string }>;
  detectedAt:    string;
}>(Events.GBP_CHANGE_DETECTED, async (event) => {
  const { entityId, userId, changedFields } = event.payload;

  // Cancel any pending check for this business — debounce multiple changes
  const existing = pendingCitationChecks.get(entityId);
  if (existing) clearTimeout(existing);

  // Schedule re-check with 2-minute delay
  const timeout = setTimeout(async () => {
    pendingCitationChecks.delete(entityId);
    try {
      // Load minimal business data for the re-check
      const { data: biz } = await db.from('businesses')
        .select('id, name, category, address')
        .eq('id', entityId).single();

      if (!biz) return;

      // Load competitors
      const { data: comps } = await db.from('competitors')
        .select('name').eq('business_id', entityId).neq('is_active', false).limit(5);

      // Detect sector from category
      const sector = biz.category?.toLowerCase().includes('restaurant') ? 'restaurant'
        : biz.category?.toLowerCase().includes('dent') ? 'dental'
        : biz.category?.toLowerCase().includes('medical') ? 'medical'
        : biz.category?.toLowerCase().includes('plumb') || biz.category?.toLowerCase().includes('electr') ? 'home_services'
        : 'general';

      // Run citation analysis with the changed field context
      // promptResults is empty — we're doing a structural analysis
      // not a live AI query. This identifies the coverage gap
      // without making new ChatGPT/Perplexity API calls.
      await aiCitationService.analyzeCitations({
        businessId:      entityId,
        userId,
        sector,
        businessName:    biz.name,
        competitorNames: (comps ?? []).map((c: any) => c.name),
        promptResults:   [], // structural analysis only — no AI calls
      });

      logger.info('[Citations] Re-check triggered by GBP change', {
        entityId,
        changedFields: changedFields.map(f => f.field),
      });
    } catch (err: any) {
      logger.error('[Citations] GBP-triggered re-check failed', {
        entityId, error: err.message,
      });
    }
  }, 2 * 60 * 1000); // 2-minute debounce

  pendingCitationChecks.set(entityId, timeout);
  logger.info('[Citations] GBP change detected — re-check scheduled', {
    entityId,
    fields:    changedFields.map(f => f.field),
    delayMins: 2,
  });
});"""
    )

    with open(path, 'w') as f: f.write(src)
    print("  ✓ AICitationService.ts — GBP_CHANGE_DETECTED subscription added")
else:
    print("  ✓ AICitationService.ts — subscription already present")
PYEOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " All four connections complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " Connection 1: GBP Guard → Overview"
echo "   dashboard.ts  — gbpGuardService.getGuardSummary() added to response"
echo "   Overview.tsx  — renders GBP Guard insight cards from data.gbpGuard"
echo "   Triggers on:  criticalUnread > 0 (🚨), totalUnread > 0 (🛡️)"
echo ""
echo " Connection 2: AI Visibility → Overview"
echo "   dashboard.ts  — latest AI visibility score added to response"
echo "   Overview.tsx  — renders AI Visibility insight from data.aiVisibility"
echo "   Triggers on:  score < 20 (alert), 20-50 (tip), improving (win), declining (alert)"
echo "   Also fixed:   AdPressureDelta signal now renders insight (was silently ignored)"
echo ""
echo " Connection 3: Review Intelligence → Review Replies"
echo "   ReviewIntelligenceService — getCachedThemes() added (zero Gemini calls)"
echo "   ReviewService             — loads themes before batch generation"
echo "   GeminiService             — knownIssues injected into prompt for rating ≤ 3"
echo "   GeminiService             — generateBatchReplies passes knownIssues through"
echo "   Effect: negative review replies now acknowledge known recurring issues"
echo ""
echo " Connection 4: Citation Intelligence → GBP Guard"
echo "   EventBus.ts              — GBP_CHANGE_DETECTED event added"
echo "   GBPGuardService.ts       — publishes event when website/address/name/phone changes"
echo "   AICitationService.ts     — subscribes, 2-min debounced re-check"
echo "   Triggers on:  website, address, name, phone changes (not hours/description)"
echo "   Zero new API calls:  structural gap analysis only"
echo ""
