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
