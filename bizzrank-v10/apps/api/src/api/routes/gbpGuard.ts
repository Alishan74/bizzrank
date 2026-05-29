/**
 * GBP Guard Routes — /api/gbp-guard
 *
 * GET  /summary?businessId=     — unread count, stats, last checked
 * GET  /alerts?businessId=      — all alerts for business + competitors
 * POST /mark-read               — mark specific alerts as read
 * POST /mark-all-read           — mark all alerts as read for a business
 * GET  /history?entityId=       — snapshot history for a business or competitor
 * GET  /fields                  — list of 20 monitored fields
 */
import { Router } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { gbpGuardService, MONITORED_FIELDS, type MonitoredField } from '../../domains/gbpguard/GBPGuardService.js';

const router = Router();

// GET /api/gbp-guard/summary
router.get('/summary', requireAuth, async (req: AuthRequest, res) => {
  try {
    const summary = await gbpGuardService.getGuardSummary(req.userId!);
    res.json(summary);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/gbp-guard/alerts?businessId=&includeRead=false&limit=50
router.get('/alerts', requireAuth, async (req: AuthRequest, res) => {
  const { businessId, includeRead, includeCompetitors, limit } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  try {
    const alerts = await gbpGuardService.getAlerts(
      businessId as string, req.userId!, {
        includeRead:        includeRead === 'true',
        includeCompetitors: includeCompetitors !== 'false',
        limit:              parseInt((limit as string) ?? '50'),
      }
    );
    res.json({ alerts });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/gbp-guard/mark-read — body: { alertIds: string[] }
router.post('/mark-read', requireAuth, async (req: AuthRequest, res) => {
  const { alertIds } = req.body;
  if (!alertIds?.length) return res.status(400).json({ error: 'alertIds required' });
  try {
    await gbpGuardService.markAsRead(alertIds, req.userId!);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/gbp-guard/mark-all-read — body: { businessId: string }
router.post('/mark-all-read', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.body;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  try {
    await gbpGuardService.markAllAsRead(businessId, req.userId!);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/gbp-guard/history?entityId=&limit=30
router.get('/history', requireAuth, async (req: AuthRequest, res) => {
  const { entityId, limit } = req.query;
  if (!entityId) return res.status(400).json({ error: 'entityId required' });
  try {
    const history = await gbpGuardService.getSnapshotHistory(
      entityId as string, req.userId!, parseInt((limit as string) ?? '30')
    );
    res.json({ history });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/gbp-guard/fields — list of monitored fields
router.get('/fields', requireAuth, (_req, res) => {
  res.json({ fields: MONITORED_FIELDS });
});

export default router;
