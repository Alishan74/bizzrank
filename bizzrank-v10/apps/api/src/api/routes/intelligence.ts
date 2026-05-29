/**
 * GET /api/intelligence/status?businessId=  — L0 passive, zero API calls
 * GET /api/intelligence/signals?businessId= — recent signals from DB
 *
 * No L1/L2/L3 manual triggers. No apiCostEstimate. No threshold management.
 * Intelligence runs fully automated in background.
 */
import { Router } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { intelligenceService } from '../../domains/intelligence/IntelligenceService.js';
import { getCacheConfidence } from '../../infrastructure/cache/CacheService.js';
import { db } from '../../infrastructure/database/SupabaseClient.js';

const router = Router();

router.get('/status', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  const [passive, opportunityScore, conf] = await Promise.all([
    intelligenceService.getPassiveIntelligence(businessId as string, req.userId!),
    intelligenceService.computeOpportunityScore(businessId as string, req.userId!),
    getCacheConfidence(businessId as string),
  ]);
  res.json({
    opportunityScore,
    monitoring: {
      active: true,
      confidence:      conf?.score ?? 100,
      changesDetected: conf?.changesDetected ?? false,
      lastChecked:     conf?.lastL1 ?? null,
      lastFullScan:    conf?.lastL3 ?? null,
    },
    recentSignals: passive.recentSignals,
    latestScore:   passive.latestScore,
  });
});

router.get('/signals', requireAuth, async (req: AuthRequest, res) => {
  const { businessId, limit = '50' } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  const { data: signals } = await db.from('intel_signals')
    .select('*').eq('business_id', businessId as string).eq('user_id', req.userId!)
    .order('detected_at', { ascending: false }).limit(parseInt(limit as string));
  res.json({ signals: signals ?? [] });
});

export default router;
