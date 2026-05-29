/**
 * Keywords Route — /api/keywords
 *
 * Manages keywords per business. Each business has a keyword limit
 * enforced by plan (Starter: 1, Growth: 2, Pro: 3, Agency: 4).
 * Keywords drive the weekly automated scans and L1 monitoring.
 */

import { Router } from 'express';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { keywordLimit, getPlan } from '../../domains/billing/BillingService.js';

const router = Router();

// ─── GET /api/keywords?businessId=xxx ────────────────────────
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  const { data } = await db.from('business_keywords')
    .select('*')
    .eq('business_id', businessId as string)
    .eq('user_id', req.userId!)
    .eq('is_active', true)
    .order('display_order');

  const { data: profile } = await db.from('profiles')
    .select('plan').eq('id', req.userId!).single();
  const plan  = profile?.plan ?? 'starter';
  const limit = keywordLimit(plan);

  res.json({
    keywords: data ?? [],
    limit,
    remaining: Math.max(0, limit - (data?.length ?? 0)),
    plan,
    planDisplayName: getPlan(plan).displayName,
  });
});

// ─── POST /api/keywords ───────────────────────────────────────
router.post('/', requireAuth, async (req: AuthRequest, res) => {
  const { businessId, keyword } = req.body;
  if (!businessId || !keyword?.trim()) {
    return res.status(400).json({ error: 'businessId and keyword required' });
  }

  // Verify business belongs to user
  const { data: biz } = await db.from('businesses')
    .select('id').eq('id', businessId).eq('user_id', req.userId!).single();
  if (!biz) return res.status(404).json({ error: 'Business not found' });

  // Plan limit check
  const { data: profile } = await db.from('profiles')
    .select('plan').eq('id', req.userId!).single();
  const plan  = profile?.plan ?? 'starter';
  const limit = keywordLimit(plan);

  const { count } = await db.from('business_keywords')
    .select('*', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .eq('user_id', req.userId!)
    .eq('is_active', true);

  if ((count ?? 0) >= limit) {
    return res.status(403).json({
      error: `Your ${getPlan(plan).displayName} plan allows ${limit} keyword${limit === 1 ? '' : 's'} per business. Upgrade to add more.`,
      limitReached: true,
      limit,
      current: count ?? 0,
    });
  }

  // Duplicate check
  const { data: existing } = await db.from('business_keywords')
    .select('id')
    .eq('business_id', businessId)
    .eq('keyword', keyword.trim().toLowerCase())
    .eq('is_active', true).single();
  if (existing) return res.status(409).json({ error: 'This keyword is already added' });

  const { data, error } = await db.from('business_keywords').insert({
    user_id:      req.userId,
    business_id:  businessId,
    keyword:      keyword.trim().toLowerCase(),
    display_order: (count ?? 0) + 1,
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ─── DELETE /api/keywords/:id ─────────────────────────────────
router.delete('/:id', requireAuth, async (req: AuthRequest, res) => {
  await db.from('business_keywords')
    .update({ is_active: false })
    .eq('id', req.params.id)
    .eq('user_id', req.userId!);
  res.json({ success: true });
});

// ─── PATCH /api/keywords/:id/reorder ─────────────────────────
router.patch('/reorder', requireAuth, async (req: AuthRequest, res) => {
  const { businessId, orderedIds } = req.body;
  if (!businessId || !Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'businessId and orderedIds required' });
  }
  for (let i = 0; i < orderedIds.length; i++) {
    await db.from('business_keywords')
      .update({ display_order: i + 1 })
      .eq('id', orderedIds[i])
      .eq('user_id', req.userId!);
  }
  res.json({ success: true });
});

export default router;
