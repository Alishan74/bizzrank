import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { getPlaceAutocomplete, getPlaceDetails } from '../../domains/identity/GoogleMapsService.js';
import { competitorLimit, getPlan } from '../../domains/billing/BillingService.js';
const router = Router();

router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  const { data } = await supabase.from('competitors').select('*').eq('business_id', businessId as string).eq('user_id', req.userId!).eq('is_active', true).order('display_order');
  res.json({ competitors: data ?? [] });
});

router.get('/limit', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  const { data: profile } = await supabase.from('profiles').select('plan').eq('id', req.userId!).single();
  const plan = profile?.plan ?? 'starter';
  const limit = competitorLimit(plan);
  const { count } = await supabase.from('competitors').select('*', { count: 'exact', head: true }).eq('business_id', businessId as string).eq('user_id', req.userId!).eq('is_active', true);
  res.json({ current: count ?? 0, limit, remaining: Math.max(0, limit - (count ?? 0)), plan, planDisplayName: getPlan(plan).displayName });
});

router.get('/autocomplete', requireAuth, async (req: AuthRequest, res) => {
  const q = req.query.q as string;
  if (!q || q.length < 2) return res.json({ suggestions: [] });
  res.json({ suggestions: await getPlaceAutocomplete(q) });
});

router.get('/place/:placeId', requireAuth, async (req, res) => {
  const d = await getPlaceDetails(req.params.placeId);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json(d);
});

router.post('/', requireAuth, async (req: AuthRequest, res) => {
  const { businessId, name, address, latitude, longitude, googlePlaceId, phone, website, category, rating } = req.body;
  if (!businessId || !name) return res.status(400).json({ error: 'businessId and name required' });
  const { data: profile } = await supabase.from('profiles').select('plan').eq('id', req.userId!).single();
  const plan = profile?.plan ?? 'starter';
  const limit = competitorLimit(plan);
  const { count } = await supabase.from('competitors').select('*', { count: 'exact', head: true }).eq('business_id', businessId).eq('user_id', req.userId!).eq('is_active', true);
  if ((count ?? 0) >= limit) return res.status(403).json({ error: `Your ${getPlan(plan).displayName} plan allows up to ${limit} competitors per business.`, limitReached: true, limit });
  if (googlePlaceId) {
    const { data: dup } = await supabase.from('competitors').select('id').eq('business_id', businessId).eq('google_place_id', googlePlaceId).eq('is_active', true).single();
    if (dup) return res.status(409).json({ error: 'This competitor is already added' });
  }
  const { data, error } = await supabase.from('competitors').insert({ user_id: req.userId, business_id: businessId, name, address, latitude, longitude, google_place_id: googlePlaceId, phone, website, category, rating, display_order: (count ?? 0) + 1 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.delete('/:id', requireAuth, async (req: AuthRequest, res) => {
  await supabase.from('competitors').update({ is_active: false }).eq('id', req.params.id).eq('user_id', req.userId!);
  res.json({ success: true });
});

export default router;
