/**
 * Review Intelligence Route — /api/review-intelligence
 * GET  ?businessId=  — returns cached or fresh intelligence
 * POST /refresh      — forces fresh Gemini analysis (costs 1 credit)
 */

import { Router } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { reviewIntelligenceService } from '../../domains/reviews/ReviewIntelligenceService.js';
import { billingService } from '../../domains/billing/BillingService.js';

const router = Router();

// GET /api/review-intelligence?businessId=xxx
// Returns cached data if < 7 days old. Zero cost if cached.
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  try {
    const intel = await reviewIntelligenceService.getIntelligence(
      businessId as string, req.userId!, false
    );

    if (!intel) {
      return res.json({
        intel: null,
        message: 'Not enough reviews to analyze (minimum 3 required)',
      });
    }

    res.json({ intel });
  } catch (err: any) {
    if (err.message === 'GEMINI_KEY_MISSING') {
      return res.json({
        intel: null,
        message: 'Gemini API key not configured',
        action: 'Add GEMINI_API_KEY to your .env file to enable AI review analysis',
        geminiMissing: true,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/review-intelligence/refresh — force fresh analysis
// Costs 1 user credit
router.post('/refresh', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.body;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  try {
    await billingService.checkAndDeductCredits({
      userId: req.userId!,
      amount: 1,
      reason: `Review intelligence refresh: ${businessId}`,
      transactionType: 'usage',
    });
  } catch (err: any) {
    return res.status(402).json({ error: err.message });
  }

  try {
    const intel = await reviewIntelligenceService.getIntelligence(
      businessId, req.userId!, true
    );
    res.json({ intel });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
