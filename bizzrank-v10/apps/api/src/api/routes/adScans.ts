import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { geoService } from '../../domains/geo/GeoService.js';
import { enqueueAdSlot } from '../../infrastructure/queue/QueueRegistry.js';
import { getAddressAutocomplete, getPlaceDetails } from '../../domains/identity/GoogleMapsService.js';

const router = Router();

router.get('/address-autocomplete', requireAuth, async (req: AuthRequest, res) => {
  const q = req.query.q as string;
  if (!q || q.length < 2) return res.json({ suggestions: [] });
  res.json({ suggestions: await getAddressAutocomplete(q) });
});

router.get('/address-details/:placeId', requireAuth, async (req, res) => {
  const d = await getPlaceDetails(req.params.placeId);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json({ lat: d.latitude, lng: d.longitude, address: d.address });
});

router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { data } = await supabase
    .from('ad_scan_sessions')
    .select('*, ad_scan_slots(id, slot_time, state, pressure_score, advertiser_count, organic_count, completed_at)')
    .eq('user_id', req.userId!)
    .order('created_at', { ascending: false })
    .limit(20);
  res.json({ sessions: data ?? [] });
});

router.get('/:sessionId', requireAuth, async (req: AuthRequest, res) => {
  const { data: session } = await supabase
    .from('ad_scan_sessions')
    .select('*')
    .eq('id', req.params.sessionId)
    .eq('user_id', req.userId!)
    .single();
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { data: slots } = await supabase
    .from('ad_scan_slots')
    .select('*')
    .eq('session_id', req.params.sessionId)
    .order('slot_index');

  res.json({ session, slots: slots ?? [] });
});

router.post('/', requireAuth, async (req: AuthRequest, res) => {
  const { businessIds, keyword, targetingMethod, radiusKm, gridSize, inputAddresses, inputZipCodes, openingHoursOverride } = req.body;

  if (!businessIds?.length) return res.status(400).json({ error: 'At least one business required' });
  if (!keyword) return res.status(400).json({ error: 'keyword required' });

  const isMulti = businessIds.length > 1;
  const method = isMulti ? 'auto_grid' : (targetingMethod ?? 'auto_grid');
  const radius = parseFloat(radiusKm ?? '5');
  const gSize = parseInt(gridSize ?? '3');

  const { data: profile } = await supabase.from('profiles').select('credits_balance').eq('id', req.userId!).single();
  if (!profile) return res.status(402).json({ error: 'Profile not found' });

  const { data: businesses } = await supabase
    .from('businesses')
    .select('id, name, latitude, longitude, opening_hours, timezone')
    .in('id', businessIds)
    .eq('user_id', req.userId!);

  if (!businesses?.length) return res.status(404).json({ error: 'No businesses found' });

  const firstBiz = businesses[0];
  let todayHours = openingHoursOverride
    ? { open: openingHoursOverride.open, close: openingHoursOverride.close }
    : geoService.getTodayHours(firstBiz.opening_hours);

  if (!todayHours) todayHours = { open: '09:00', close: '18:00' };

  const scheduledTimes = geoService.generateScanSchedule(todayHours.open, todayHours.close, 60);

  // Filter out times that have already passed
  const now = new Date();
  const validTimes = scheduledTimes.filter(t => {
    const [h, m] = t.split(':').map(Number);
    const slotTime = new Date(now);
    slotTime.setHours(h, m, 0, 0);
    return slotTime > now;
  });

  if (validTimes.length === 0) {
    return res.status(400).json({ error: 'All scheduled times have already passed for today. Try again tomorrow or set custom hours.' });
  }

  // Each slot = 1 full 25-point grid scan = 25 credits (matches organic scan credit cost)
  const slotsCount = validTimes.length * businesses.length;
  const totalSlots = slotsCount * 25;

  if (profile.credits_balance < totalSlots) {
    return res.status(402).json({
      error: 'This session requires ' + totalSlots + ' credits (' + validTimes.length + ' time slots x ' + businesses.length + ' businesses). You have ' + profile.credits_balance + ' credits.',
      required: totalSlots,
      available: profile.credits_balance,
    });
  }

  // Create session FIRST — then deduct credits
  // If session insert fails, no credits are lost (was previously reversed)
  const { data: session, error } = await supabase.from('ad_scan_sessions').insert({
    user_id: req.userId, keyword,
    targeting_method: method,
    radius_km: radius, grid_size: gSize,
    input_addresses: (!isMulti && method === 'addresses') ? inputAddresses : null,
    input_zip_codes: (!isMulti && method === 'zip_codes') ? inputZipCodes : null,
    business_ids: businessIds,
    interval_minutes: 60,
    scheduled_times: validTimes,
    timezone: firstBiz.timezone ?? 'UTC',
    state: 'scheduled',
    scans_completed: 0,
    scans_total: totalSlots,
    scan_date: new Date().toISOString().split('T')[0],
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Deduct credits AFTER session is confirmed created
  await supabase.from('profiles').update({ credits_balance: profile.credits_balance - totalSlots }).eq('id', req.userId!);
  await supabase.from('credit_transactions').insert({
    user_id: req.userId, amount: -totalSlots, balance_after: profile.credits_balance - totalSlots,
    reason: 'Ad scan: ' + keyword + ' (' + slotsCount + ' slots × 25 pts)',
    transaction_type: 'usage',
  });

  // Create slot records
  const slotRows: any[] = [];
  for (const biz of businesses) {
    for (let i = 0; i < validTimes.length; i++) {
      const [h, m] = validTimes[i].split(':').map(Number);
      const scheduledAt = new Date();
      scheduledAt.setHours(h, m, 0, 0);
      slotRows.push({
        session_id: session.id, user_id: req.userId,
        business_id: biz.id, slot_time: validTimes[i],
        slot_index: i, scheduled_at: scheduledAt.toISOString(),
        state: 'pending',
      });
    }
  }

  // Insert slots first — DB assigns real UUIDs
  const { data: insertedSlots } = await supabase.from('ad_scan_slots').insert(slotRows).select('id, business_id, slot_index, slot_time');

  // Enqueue using real DB-assigned IDs (not in-memory stubs)
  for (const slot of (insertedSlots ?? [])) {
    const [_h, _m] = slot.slot_time.split(':').map(Number);
    const _slotTime = new Date();
    _slotTime.setHours(_h, _m, 0, 0);
    const _delayMs = Math.max(0, _slotTime.getTime() - Date.now());
    await enqueueAdSlot({
      slotId: slot.id,
      sessionId: session.id, userId: req.userId, businessId: slot.business_id,
      keyword, radiusKm: radius, gridSize: gSize,
      targetingMethod: method,
      inputAddresses: (!isMulti && method === 'addresses') ? inputAddresses : null,
      inputZipCodes: (!isMulti && method === 'zip_codes') ? inputZipCodes : null,
    }, _delayMs);
  }

  // Update session state to running
  await supabase.from('ad_scan_sessions').update({ state: 'running' }).eq('id', session.id);

  res.status(201).json({
    sessionId: session.id,
    scheduledTimes: validTimes,
    totalSlots,
    creditCost: totalSlots,
    message: 'Ad scan session scheduled for ' + validTimes.length + ' time slots today',
  });
});

router.post('/:sessionId/stop', requireAuth, async (req: AuthRequest, res) => {
  // Mark pending jobs as skipped
  const { data: slots } = await supabase
    .from('ad_scan_slots')
    .select('id')
    .eq('session_id', req.params.sessionId)
    .eq('state', 'pending');

  if (slots?.length) {
    const slotIds = slots.map(s => s.id);
    await supabase.from('scan_jobs')
      .update({ state: 'skipped' })
      .in('reference_id', slotIds);
    await supabase.from('ad_scan_slots')
      .update({ state: 'skipped' })
      .eq('session_id', req.params.sessionId)
      .eq('state', 'pending');
  }

  await supabase.from('ad_scan_sessions').update({
    state: 'stopped',
    stopped_at: new Date().toISOString(),
  }).eq('id', req.params.sessionId).eq('user_id', req.userId!);

  res.json({ success: true });
});

export default router;
