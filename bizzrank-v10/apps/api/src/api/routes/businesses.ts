import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { getPlaceAutocomplete, getPlaceDetails } from '../../domains/identity/GoogleMapsService.js';
import { businessLimit } from '../../domains/billing/BillingService.js';
const router = Router();

router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { data } = await supabase.from('businesses').select('*').eq('user_id', req.userId!).eq('is_active', true).order('created_at', { ascending: false });
  res.json({ businesses: data ?? [] });
});

router.get('/autocomplete', requireAuth, async (req: AuthRequest, res) => {
  const q = req.query.q as string;
  if (!q || q.length < 2) return res.json({ suggestions: [] });
  const suggestions = await getPlaceAutocomplete(q);
  res.json({ suggestions });
});

router.get('/place/:placeId', requireAuth, async (req, res) => {
  const d = await getPlaceDetails(req.params.placeId);
  if (!d) return res.status(404).json({ error: 'Place not found' });
  res.json(d);
});

router.post('/', requireAuth, async (req: AuthRequest, res) => {
  const { name, address, latitude, longitude, phone, website, category, googlePlaceId, openingHours } = req.body;
  if (!name) return res.status(400).json({ error: 'Business name required' });
  if (!latitude || !longitude) return res.status(400).json({ error: 'Please select your business from Google Maps suggestions to set the location automatically' });
  const { data: profile } = await supabase.from('profiles').select('plan').eq('id', req.userId!).single();
  const limit = businessLimit(profile?.plan ?? 'starter');
  const { count } = await supabase.from('businesses').select('*', { count: 'exact', head: true }).eq('user_id', req.userId!).eq('is_active', true);
  if (limit !== 999 && (count ?? 0) >= limit) return res.status(403).json({ error: `Your ${profile?.plan} plan allows ${limit} business${limit === 1 ? '' : 'es'}. Upgrade to add more.`, limitReached: true });
  const { data, error } = await supabase.from('businesses').insert({ user_id: req.userId, name, address, latitude, longitude, phone, website, category, google_place_id: googlePlaceId, opening_hours: openingHours ?? null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// Update brand voice settings
router.patch('/:id/brand-voice', requireAuth, async (req: AuthRequest, res) => {
  const { brandVoice } = req.body;
  const { data, error } = await supabase.from('businesses').update({ brand_voice: brandVoice }).eq('id', req.params.id).eq('user_id', req.userId!).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Update opening hours
router.patch('/:id/hours', requireAuth, async (req: AuthRequest, res) => {
  const { openingHours, timezone } = req.body;
  const { data, error } = await supabase.from('businesses').update({ opening_hours: openingHours, timezone: timezone ?? 'UTC' }).eq('id', req.params.id).eq('user_id', req.userId!).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/import-gbp', requireAuth, async (req: AuthRequest, res) => {
  const { locationIds } = req.body;
  if (!locationIds?.length) return res.status(400).json({ error: 'No locations selected' });
  const { data: profile } = await supabase.from('profiles').select('plan').eq('id', req.userId!).single();
  const limit = businessLimit(profile?.plan ?? 'starter');
  const { count: existing } = await supabase.from('businesses').select('*', { count: 'exact', head: true }).eq('user_id', req.userId!).eq('is_active', true);
  const canAdd = limit === 999 ? locationIds.length : Math.max(0, limit - (existing ?? 0));
  if (canAdd === 0) return res.status(403).json({ error: 'Business limit reached for your plan', limitReached: true });
  const { data: pending } = await supabase.from('gbp_pending_locations').select('locations').eq('user_id', req.userId!).single();
  const toImport = (pending?.locations ?? []).filter((l: any) => locationIds.includes(l.gbpLocationId)).slice(0, canAdd);
  const imported = [];
  for (const loc of toImport) {
    const { data: biz } = await supabase.from('businesses').insert({ user_id: req.userId, name: loc.name, address: loc.address, latitude: loc.latitude, longitude: loc.longitude, phone: loc.phone, website: loc.website, category: loc.category, gbp_location_id: loc.gbpLocationId }).select().single();
    if (biz?.id) imported.push(biz);
  }
  await supabase.from('gbp_pending_locations').delete().eq('user_id', req.userId!);
  res.json({ imported });
});

export default router;
