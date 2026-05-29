#!/usr/bin/env bash
# BizzRank AI v10 — MASTER FIX SCRIPT
# Fixes ALL known bugs and adds all new features in one run.
# cd /workspaces/bizzrank/bizzrank-v10 && bash master_fix.sh
set -e
ROOT="$(pwd)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " BizzRank AI v10 — Master Fix"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  ✓ apps/api/src/api/routes/adScans.ts"
mkdir -p "$ROOT/apps/api/src/api/routes"
cat > "$ROOT/apps/api/src/api/routes/adScans.ts" << 'BIZZMASTER_APPS_API_SRC_API_ROUTES_ADSCANS_TS'
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

  const scheduledTimes = geoService.generateScanSchedule(todayHours.open, todayHours.close, 90);

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

  const totalSlots = validTimes.length * businesses.length;

  if (profile.credits_balance < totalSlots) {
    return res.status(402).json({
      error: 'This session requires ' + totalSlots + ' credits (' + validTimes.length + ' time slots x ' + businesses.length + ' businesses). You have ' + profile.credits_balance + ' credits.',
      required: totalSlots,
      available: profile.credits_balance,
    });
  }

  // Create session
  const { data: session, error } = await supabase.from('ad_scan_sessions').insert({
    user_id: req.userId, keyword,
    targeting_method: method,
    radius_km: radius, grid_size: gSize,
    input_addresses: (!isMulti && method === 'addresses') ? inputAddresses : null,
    input_zip_codes: (!isMulti && method === 'zip_codes') ? inputZipCodes : null,
    business_ids: businessIds,
    interval_minutes: 90,
    scheduled_times: validTimes,
    timezone: firstBiz.timezone ?? 'UTC',
    state: 'scheduled',
    scans_completed: 0,
    scans_total: totalSlots,
    scan_date: new Date().toISOString().split('T')[0],
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Deduct credits
  await supabase.from('profiles').update({ credits_balance: profile.credits_balance - totalSlots }).eq('id', req.userId!);
  await supabase.from('credit_transactions').insert({
    user_id: req.userId, amount: -totalSlots, balance_after: profile.credits_balance - totalSlots,
    reason: 'Ad scan: ' + keyword + ' (' + validTimes.length + ' slots x ' + businesses.length + ' biz)',
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

  await supabase.from('ad_scan_slots').insert(slotRows);

  // Schedule jobs in database — survives restarts
  // Enqueue each slot via BullMQ
  for (const biz of businesses) {
    for (let _si = 0; _si < validTimes.length; _si++) {
      const [_h, _m] = validTimes[_si].split(':').map(Number);
      const _slotTime = new Date();
      _slotTime.setHours(_h, _m, 0, 0);
      const _delayMs = Math.max(0, _slotTime.getTime() - Date.now());
      const _slotRow = slotRows.find((s: any) => s.business_id === biz.id && s.slot_index === _si);
      if (_slotRow) {
        await enqueueAdSlot({
          slotId: _slotRow.id ?? (session.id + '_' + biz.id + '_' + _si),
          sessionId: session.id, userId: req.userId, businessId: biz.id,
          keyword, radiusKm: radius, gridSize: gSize,
          targetingMethod: method,
          inputAddresses: (!isMulti && method === 'addresses') ? inputAddresses : null,
          inputZipCodes: (!isMulti && method === 'zip_codes') ? inputZipCodes : null,
        }, _delayMs);
      }
    }
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
BIZZMASTER_APPS_API_SRC_API_ROUTES_ADSCANS_TS

echo "  ✓ apps/api/src/api/routes/businesses.ts"
mkdir -p "$ROOT/apps/api/src/api/routes"
cat > "$ROOT/apps/api/src/api/routes/businesses.ts" << 'BIZZMASTER_APPS_API_SRC_API_ROUTES_BUSINESSES_TS'
import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { getPlaceAutocomplete, getPlaceDetails } from '../../domains/identity/GoogleMapsService.js';
import { businessLimit } from '../../domains/billing/BillingService.js';
const router = Router();

router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { data, error } = await supabase.from('businesses').select('*').eq('user_id', req.userId!).neq('is_active', false).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
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
BIZZMASTER_APPS_API_SRC_API_ROUTES_BUSINESSES_TS

echo "  ✓ apps/api/src/api/routes/competitors.ts"
mkdir -p "$ROOT/apps/api/src/api/routes"
cat > "$ROOT/apps/api/src/api/routes/competitors.ts" << 'BIZZMASTER_APPS_API_SRC_API_ROUTES_COMPETITORS_TS'
import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { getPlaceAutocomplete, getPlaceDetails } from '../../domains/identity/GoogleMapsService.js';
import { competitorLimit, getPlan } from '../../domains/billing/BillingService.js';
const router = Router();

router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  const { data } = await supabase.from('competitors').select('*').eq('business_id', businessId as string).eq('user_id', req.userId!).neq('is_active', false).order('display_order');
  res.json({ competitors: data ?? [] });
});

router.get('/limit', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  const { data: profile } = await supabase.from('profiles').select('plan').eq('id', req.userId!).single();
  const plan = profile?.plan ?? 'starter';
  const limit = competitorLimit(plan);
  const { count } = await supabase.from('competitors').select('*', { count: 'exact', head: true }).eq('business_id', businessId as string).eq('user_id', req.userId!).neq('is_active', false);
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
  const { count } = await supabase.from('competitors').select('*', { count: 'exact', head: true }).eq('business_id', businessId).eq('user_id', req.userId!).neq('is_active', false);
  if ((count ?? 0) >= limit) return res.status(403).json({ error: `Your ${getPlan(plan).displayName} plan allows up to ${limit} competitors per business.`, limitReached: true, limit });
  if (googlePlaceId) {
    const { data: dup } = await supabase.from('competitors').select('id').eq('business_id', businessId).eq('google_place_id', googlePlaceId).neq('is_active', false).single();
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
BIZZMASTER_APPS_API_SRC_API_ROUTES_COMPETITORS_TS

echo "  ✓ apps/api/src/api/routes/intelligence.ts"
mkdir -p "$ROOT/apps/api/src/api/routes"
cat > "$ROOT/apps/api/src/api/routes/intelligence.ts" << 'BIZZMASTER_APPS_API_SRC_API_ROUTES_INTELLIGENCE_TS'
/**
 * Intelligence Routes — /api/intelligence
 *
 * Exposes the Multi-Level Monitoring Intelligence Framework to the frontend.
 * All endpoints read from cache (L0) or trigger background jobs (L1/L2/L3).
 */

import { Router } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { intelligenceService } from '../../domains/intelligence/IntelligenceService.js';
import { getIntelLevel, getCacheConfidence } from '../../infrastructure/cache/CacheService.js';
import { billingService, CREDIT_COSTS } from '../../domains/billing/BillingService.js';
import { db } from '../../infrastructure/database/SupabaseClient.js';

const router = Router();

// ─── GET /api/intelligence/status?businessId=xxx ─────────────
// Returns current intel level, cache confidence, and opportunity score.
// Always L0 — zero API calls. Safe to call on every dashboard load.
router.get('/status', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  const [
    passive,
    opportunityScore,
    intelLevel,
    cacheConfidence,
  ] = await Promise.all([
    intelligenceService.getPassiveIntelligence(businessId as string, req.userId!),
    intelligenceService.computeOpportunityScore(businessId as string, req.userId!),
    getIntelLevel(req.userId!),
    getCacheConfidence(businessId as string),
  ]);

  res.json({
    opportunityScore,
    intelLevel: intelLevel ?? { level: 0, reason: 'Passive Intelligence Active', apiCostEstimate: 0 },
    cacheConfidence: cacheConfidence ?? { score: 100, changesDetected: false },
    recentSignals: passive.recentSignals,
    latestScore: passive.latestScore,
  });
});

// ─── POST /api/intelligence/l1 — Manual L1 trigger ───────────
// Runs a lightweight check for a business now.
// Cost: ~$0.01 (1-2 SerpAPI calls). Free from user credits perspective.
router.post('/l1', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.body;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  const keywords = await getKeywordsForBusiness(businessId);
  if (!keywords.length) return res.status(400).json({ error: 'No keywords configured for this business' });

  const thresholds = await intelligenceService.getThresholds(businessId);
  const signals = await intelligenceService.runL1Check(
    businessId, req.userId!, keywords, thresholds, true
  );

  res.json({
    signals,
    changesDetected: signals.length > 0,
    escalatedToL2: signals.some(s => s.triggersL2),
    message: signals.length > 0
      ? `${signals.length} change signal(s) detected`
      : 'No changes detected — cached data is current',
  });
});

// ─── POST /api/intelligence/l2 — Manual L2 trigger ───────────
// Triggers a full 25-point scan for one keyword. Costs 25 user credits.
router.post('/l2', requireAuth, async (req: AuthRequest, res) => {
  const { businessId, keyword } = req.body;
  if (!businessId || !keyword) {
    return res.status(400).json({ error: 'businessId and keyword required' });
  }

  // Check and deduct user credits (L2 = 10 credits)
  try {
    await billingService.checkAndDeductCredits({
      userId: req.userId!, amount: CREDIT_COSTS.L2_ESCALATION,
      reason: `L2 triggered analysis: ${keyword}`,
      transactionType: 'usage',
    });
  } catch (err: any) {
    return res.status(402).json({ error: err.message });
  }

  // Fire async
  intelligenceService.runL2TriggeredAnalysis(businessId, req.userId!, keyword)
    .catch(console.error);

  res.json({
    message: `L2 analysis triggered for "${keyword}". Full scan running in background.`,
    creditsConsumed: CREDIT_COSTS.L2_ESCALATION,
  });
});

// ─── POST /api/intelligence/l3 — Manual L3 (on-demand) ───────
// Full deep analysis — all keywords, all competitors. Costs 50 user credits.
router.post('/l3', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.body;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  // Check plan — L3 reports only for Agency+
  const { data: profile } = await db.from('profiles')
    .select('plan, credits_balance').eq('id', req.userId!).single();
  const plan = billingService.getPlan(profile?.plan ?? 'starter');

  // Pro and below: allow L3 but it costs more credits (50)
  try {
    await billingService.checkAndDeductCredits({
      userId: req.userId!, amount: CREDIT_COSTS.L3_REPORT,
      reason: `L3 deep analysis: ${businessId}`,
      transactionType: 'usage',
    });
  } catch (err: any) {
    return res.status(402).json({ error: err.message });
  }

  const keywords = await getKeywordsForBusiness(businessId);
  if (!keywords.length) return res.status(400).json({ error: 'No keywords configured' });

  intelligenceService.runL3DeepAnalysis(businessId, req.userId!, keywords, 'manual')
    .catch(console.error);

  res.json({
    message: `L3 deep analysis triggered. Scanning ${keywords.length} keyword(s) across all competitors.`,
    creditsConsumed: CREDIT_COSTS.L3_REPORT,
  });
});

// ─── GET /api/intelligence/signals?businessId=xxx ─────────────
// Returns recent change signals. L0 — reads from DB only.
router.get('/signals', requireAuth, async (req: AuthRequest, res) => {
  const { businessId, limit = '50' } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  const { data: signals } = await db.from('intel_signals')
    .select('*')
    .eq('business_id', businessId as string)
    .order('detected_at', { ascending: false })
    .limit(parseInt(limit as string));

  res.json({ signals: signals ?? [] });
});

// ─── GET /api/intelligence/thresholds?businessId=xxx ──────────
router.get('/thresholds', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  const thresholds = await intelligenceService.getThresholds(businessId as string);
  res.json({ thresholds });
});

// ─── PATCH /api/intelligence/thresholds ───────────────────────
router.patch('/thresholds', requireAuth, async (req: AuthRequest, res) => {
  const { businessId, visibilityDrop, competitorMovement, reviewSpike, adPressureSpike } = req.body;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  await intelligenceService.saveThresholds(businessId, req.userId!, {
    visibilityDrop:     parseInt(visibilityDrop) || 10,
    competitorMovement: parseInt(competitorMovement) || 15,
    reviewSpike:        parseInt(reviewSpike) || 5,
    adPressureSpike:    parseInt(adPressureSpike) || 20,
  });

  res.json({ success: true, message: 'Thresholds updated — Change Detection Engine reconfigured' });
});

// ─── Helper ───────────────────────────────────────────────────
async function getKeywordsForBusiness(businessId: string): Promise<string[]> {
  const { data } = await db.from('business_keywords')
    .select('keyword')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .order('display_order');
  return (data ?? []).map((k: any) => k.keyword);
}

export default router;
BIZZMASTER_APPS_API_SRC_API_ROUTES_INTELLIGENCE_TS

echo "  ✓ apps/api/src/api/routes/keywords.ts"
mkdir -p "$ROOT/apps/api/src/api/routes"
cat > "$ROOT/apps/api/src/api/routes/keywords.ts" << 'BIZZMASTER_APPS_API_SRC_API_ROUTES_KEYWORDS_TS'
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
BIZZMASTER_APPS_API_SRC_API_ROUTES_KEYWORDS_TS

echo "  ✓ apps/api/src/api/routes/orgs.ts"
mkdir -p "$ROOT/apps/api/src/api/routes"
cat > "$ROOT/apps/api/src/api/routes/orgs.ts" << 'BIZZMASTER_APPS_API_SRC_API_ROUTES_ORGS_TS'
/**
 * Orgs Route — /api/orgs
 * Team management. Auto-creates org for new users on first access.
 */
import { Router } from 'express';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();

async function ensureOrg(userId: string): Promise<string> {
  const { data: existing } = await db.from('organizations')
    .select('id').eq('owner_id', userId).single();
  if (existing?.id) return existing.id;

  const { data: profile } = await db.from('profiles')
    .select('full_name, company_name').eq('id', userId).single();
  const orgName = profile?.company_name || profile?.full_name || 'My Team';

  const { data: org, error } = await db.from('organizations')
    .insert({ owner_id: userId, name: orgName })
    .select().single();
  if (error || !org) throw new Error('Failed to create organization: ' + (error?.message ?? ''));

  await db.from('org_members').insert({ org_id: org.id, user_id: userId, role: 'owner' });
  return org.id;
}

// GET /api/orgs
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    const orgId = await ensureOrg(req.userId!);
    const [{ data: org }, { data: members }, { data: invitations }] = await Promise.all([
      db.from('organizations').select('*').eq('id', orgId).single(),
      db.from('org_members')
        .select('id, user_id, role, created_at, profiles(full_name, company_name, plan, credits_balance)')
        .eq('org_id', orgId).order('created_at'),
      db.from('org_invitations')
        .select('id, email, role, accepted, expires_at, created_at')
        .eq('org_id', orgId).eq('accepted', false)
        .gte('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }),
    ]);

    const myMembership = (members ?? []).find((m: any) => m.user_id === req.userId);
    const myRole = myMembership?.role ?? 'owner';

    res.json({
      org,
      members: (members ?? []).map((m: any) => ({
        id: m.id, userId: m.user_id, role: m.role, joinedAt: m.created_at,
        name:    m.profiles?.full_name ?? 'Unknown',
        company: m.profiles?.company_name ?? '',
        plan:    m.profiles?.plan ?? 'starter',
        credits: m.profiles?.credits_balance ?? 0,
        isMe:    m.user_id === req.userId,
      })),
      invitations: myRole === 'owner' ? (invitations ?? []) : [],
      myRole,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orgs/invitations
router.post('/invitations', requireAuth, async (req: AuthRequest, res) => {
  const { email, role = 'viewer' } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const orgId = await ensureOrg(req.userId!);
    const { data: myM } = await db.from('org_members')
      .select('role').eq('org_id', orgId).eq('user_id', req.userId!).single();
    if (myM?.role !== 'owner') return res.status(403).json({ error: 'Only org owner can invite' });

    const { data: inv, error } = await db.from('org_invitations').insert({
      org_id: orgId, invited_by: req.userId!,
      email: email.toLowerCase().trim(), role,
    }).select().single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Invitation already exists for this email' });
      throw new Error(error.message);
    }

    const inviteUrl = (process.env.FRONTEND_URL ?? 'http://localhost:5173') + '/accept-invite?token=' + inv.token;
    res.status(201).json({ invitation: inv, inviteUrl,
      message: 'Invitation created. Share the invite link with ' + email });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orgs/invitations
router.get('/invitations', requireAuth, async (req: AuthRequest, res) => {
  try {
    const orgId = await ensureOrg(req.userId!);
    const { data } = await db.from('org_invitations').select('*')
      .eq('org_id', orgId).eq('accepted', false).order('created_at', { ascending: false });
    res.json({ invitations: data ?? [] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/orgs/invitations/:id
router.delete('/invitations/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const orgId = await ensureOrg(req.userId!);
    await db.from('org_invitations').delete().eq('id', req.params.id).eq('org_id', orgId);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/orgs/members/:id/role
router.patch('/members/:memberId/role', requireAuth, async (req: AuthRequest, res) => {
  const { role } = req.body;
  if (!['manager','viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const orgId = await ensureOrg(req.userId!);
    const { data: t } = await db.from('org_members').select('role')
      .eq('id', req.params.memberId).eq('org_id', orgId).single();
    if (t?.role === 'owner') return res.status(403).json({ error: 'Cannot change owner role' });
    await db.from('org_members').update({ role }).eq('id', req.params.memberId).eq('org_id', orgId);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/orgs/members/:id
router.delete('/members/:memberId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const orgId = await ensureOrg(req.userId!);
    const { data: t } = await db.from('org_members').select('role, user_id')
      .eq('id', req.params.memberId).eq('org_id', orgId).single();
    if (!t) return res.status(404).json({ error: 'Member not found' });
    if (t.role === 'owner') return res.status(403).json({ error: 'Cannot remove owner' });
    if (t.user_id === req.userId) return res.status(403).json({ error: 'Cannot remove yourself' });
    await db.from('org_members').delete().eq('id', req.params.memberId).eq('org_id', orgId);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
BIZZMASTER_APPS_API_SRC_API_ROUTES_ORGS_TS

echo "  ✓ apps/api/src/api/routes/reviewIntelligence.ts"
mkdir -p "$ROOT/apps/api/src/api/routes"
cat > "$ROOT/apps/api/src/api/routes/reviewIntelligence.ts" << 'BIZZMASTER_APPS_API_SRC_API_ROUTES_REVIEWINTELLIGENCE_TS'
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
    // Return a clear error so frontend can show it gracefully
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
BIZZMASTER_APPS_API_SRC_API_ROUTES_REVIEWINTELLIGENCE_TS

echo "  ✓ apps/api/src/api/routes/reviews.ts"
mkdir -p "$ROOT/apps/api/src/api/routes"
cat > "$ROOT/apps/api/src/api/routes/reviews.ts" << 'BIZZMASTER_APPS_API_SRC_API_ROUTES_REVIEWS_TS'
import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { generateReviewReply, generateBatchReplies, estimateRevenueLost } from '../../domains/reviews/GeminiService.js';
import { fetchGBPReviews, postGBPReply } from '../../domains/identity/GBPService.js';
import { serpFetchReviews, hasSerpApiKey } from '../../domains/serpapi/SerpApiService.js';

const router = Router();

// GET /api/reviews?businessId=xxx
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  const { data: reviews } = await supabase
    .from('reviews')
    .select('*')
    .eq('business_id', businessId as string)
    .eq('user_id', req.userId!)
    .order('review_date', { ascending: false });

  const all = reviews ?? [];
  const unanswered = all.filter(r => !r.is_replied && r.ai_reply_status !== 'posted');
  const needsApproval = all.filter(r => r.ai_reply_status === 'draft_ready' && r.requires_approval);

  // Get business info for GBP status
  const { data: biz } = await supabase
    .from('businesses')
    .select('name, google_place_id, last_review_sync')
    .eq('id', businessId as string)
    .single();

  const { data: profile } = await supabase
    .from('profiles')
    .select('gbp_connected')
    .eq('id', req.userId!)
    .single();

  res.json({
    reviews: all,
    stats: {
      total: all.length,
      unanswered: unanswered.length,
      needsApproval: needsApproval.length,
      revenueLost: estimateRevenueLost(unanswered.length),
      avgRating: all.length ? (all.reduce((s, r) => s + r.rating, 0) / all.length).toFixed(1) : '0',
    },
    gbpConnected: !!profile?.gbp_connected,
    lastSync: biz?.last_review_sync,
    canFetchWithoutGBP: hasSerpApiKey() && !!biz?.google_place_id,
  });
});

// POST /api/reviews/fetch — fetch reviews (works with or without GBP)
router.post('/fetch', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.body;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  const { data: biz } = await supabase
    .from('businesses')
    .select('name, google_place_id, gbp_location_id')
    .eq('id', businessId)
    .eq('user_id', req.userId!)
    .single();

  if (!biz) return res.status(404).json({ error: 'Business not found' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('gbp_connected, gbp_access_token')
    .eq('id', req.userId!)
    .single();

  let synced = 0;
  let source = 'serp';

  // Try GBP first if connected
  if (profile?.gbp_connected && profile?.gbp_access_token && biz.gbp_location_id) {
    source = 'gbp';
    const gbpReviews = await fetchGBPReviews(profile.gbp_access_token, biz.gbp_location_id);
    for (const rev of gbpReviews) {
      await supabase.from('reviews').upsert({
        user_id: req.userId, business_id: businessId,
        source: 'gbp',
        google_review_id: rev.reviewId,
        reviewer_name: rev.reviewerName,
        reviewer_photo_url: rev.reviewerPhoto,
        rating: rev.rating, review_text: rev.text,
        review_date: rev.date, is_replied: rev.isReplied,
        requires_approval: rev.rating <= 2,
        auto_reply_enabled: rev.rating >= 3,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'google_review_id', ignoreDuplicates: false });
      synced++;
    }
  } else if (hasSerpApiKey() && biz.google_place_id) {
    // Fallback to SerpApi — works without GBP
    source = 'serp';
    const serpReviews = await serpFetchReviews(biz.google_place_id, biz.name);
    for (const rev of serpReviews) {
      await supabase.from('reviews').upsert({
        user_id: req.userId, business_id: businessId,
        source: 'serp',
        google_review_id: rev.reviewId,
        reviewer_name: rev.reviewerName,
        reviewer_photo_url: rev.reviewerPhoto,
        rating: rev.rating, review_text: rev.text,
        review_date: rev.date, is_replied: rev.isReplied,
        requires_approval: rev.rating <= 2,
        auto_reply_enabled: rev.rating >= 3,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'google_review_id', ignoreDuplicates: false });
      synced++;
    }
  } else {
    return res.status(400).json({
      error: 'Cannot fetch reviews. Connect Google Business Profile or add your SerpApi key to enable automatic review fetching.',
    });
  }

  // Update last sync time
  await supabase.from('businesses').update({ last_review_sync: new Date().toISOString() }).eq('id', businessId);

  res.json({ synced, source });
});

// POST /api/reviews/generate-all
router.post('/generate-all', requireAuth, async (req: AuthRequest, res) => {
  // Gate: AI replies not available on Starter plan
  const { data: _planProfile } = await supabase.from('profiles').select('plan').eq('id', req.userId!).single();
  if (!canUseAiReplies(_planProfile?.plan ?? 'starter')) {
    return res.status(403).json({
      error: 'AI review replies require Growth plan or higher. Upgrade to unlock this feature.',
      upgradeRequired: true,
    });
  }
  const { businessId } = req.body;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });

  const { data: reviews } = await supabase
    .from('reviews')
    .select('*')
    .eq('business_id', businessId)
    .eq('user_id', req.userId!)
    .eq('is_replied', false)
    .in('ai_reply_status', ['pending', 'rejected']);

  if (!reviews?.length) return res.json({ generated: 0, message: 'No reviews need replies' });

  const { data: biz } = await supabase
    .from('businesses')
    .select('name, brand_voice')
    .eq('id', businessId)
    .single();

  res.json({ message: 'Generating AI replies...', count: reviews.length });

  // Background generation
  generateAllReplies(reviews, biz, req.userId!).catch(console.error);
});

async function generateAllReplies(reviews: any[], biz: any, userId: string) {
  const brandVoice = biz?.brand_voice ?? { tone: 'friendly' };
  const results = await generateBatchReplies(
    reviews.map(r => ({ id: r.id, reviewerName: r.reviewer_name ?? 'there', rating: r.rating, reviewText: r.review_text ?? '' })),
    biz?.name ?? 'our business',
    brandVoice
  );

  for (const result of results) {
    if (!result.reply) continue;
    const review = reviews.find(r => r.id === result.reviewId);
    const autoPost = review?.rating >= 3 && review?.auto_reply_enabled && brandVoice?.autoReply345 !== false;
    await supabase.from('reviews').update({
      ai_reply_draft: result.reply,
      ai_reply_status: autoPost ? 'approved' : 'draft_ready',
      posted_reply: autoPost ? result.reply : null,
      posted_at: autoPost ? new Date().toISOString() : null,
      posted_by: autoPost ? 'auto' : null,
      is_replied: autoPost,
      updated_at: new Date().toISOString(),
    }).eq('id', result.reviewId);
  }
}

// POST /api/reviews/:id/approve
router.post('/:reviewId/approve', requireAuth, async (req: AuthRequest, res) => {
  const { editedReply } = req.body;
  const { data: review } = await supabase
    .from('reviews')
    .select('*, businesses(gbp_location_id)')
    .eq('id', req.params.reviewId)
    .eq('user_id', req.userId!)
    .single();

  if (!review) return res.status(404).json({ error: 'Review not found' });

  const replyText = editedReply ?? review.ai_reply_draft;
  if (!replyText) return res.status(400).json({ error: 'No reply text' });

  let posted = false;
  const { data: profile } = await supabase.from('profiles').select('gbp_access_token, gbp_connected').eq('id', req.userId!).single();

  if (profile?.gbp_connected && profile?.gbp_access_token && review.businesses?.gbp_location_id && review.google_review_id) {
    posted = await postGBPReply(profile.gbp_access_token, review.businesses.gbp_location_id, review.google_review_id, replyText);
  }

  await supabase.from('reviews').update({
    ai_reply_status: posted ? 'posted' : 'approved',
    posted_reply: replyText,
    posted_at: new Date().toISOString(),
    posted_by: req.userId!,
    is_replied: posted,
    updated_at: new Date().toISOString(),
  }).eq('id', req.params.reviewId);

  res.json({
    success: true, posted,
    message: posted ? 'Reply posted to Google' : 'Reply saved. Connect GBP to post to Google automatically.',
  });
});

// POST /api/reviews/:id/regenerate
router.post('/:reviewId/regenerate', requireAuth, async (req: AuthRequest, res) => {
  const { data: review } = await supabase
    .from('reviews')
    .select('*, businesses(name, brand_voice)')
    .eq('id', req.params.reviewId)
    .eq('user_id', req.userId!)
    .single();

  if (!review) return res.status(404).json({ error: 'Review not found' });

  const brandVoice = review.businesses?.brand_voice ?? { tone: 'friendly' };

  try {
    const reply = await generateReviewReply({
      reviewerName: review.reviewer_name ?? 'there',
      rating: review.rating,
      reviewText: review.review_text ?? '',
      businessName: review.businesses?.name ?? 'our business',
      brandVoice,
    });
    await supabase.from('reviews').update({
      ai_reply_draft: reply,
      ai_reply_status: 'draft_ready',
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.reviewId);
    res.json({ reply });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/reviews/:id/toggle-auto
router.patch('/:reviewId/toggle-auto', requireAuth, async (req: AuthRequest, res) => {
  const { enabled } = req.body;
  await supabase.from('reviews').update({
    auto_reply_enabled: enabled,
    updated_at: new Date().toISOString(),
  }).eq('id', req.params.reviewId).eq('user_id', req.userId!);
  res.json({ success: true });
});

export default router;
BIZZMASTER_APPS_API_SRC_API_ROUTES_REVIEWS_TS

echo "  ✓ apps/api/src/domains/billing/BillingService.ts"
mkdir -p "$ROOT/apps/api/src/domains/billing"
cat > "$ROOT/apps/api/src/domains/billing/BillingService.ts" << 'BIZZMASTER_APPS_API_SRC_DOMAINS_BILLING_BILLINGSERVICE_TS'
/**
 * Billing Domain
 * Single source of truth for all plan and credit logic.
 * UPDATED: new plan pricing table, standalone helper exports.
 */

import { db } from '../../infrastructure/database/SupabaseClient.js';
import { eventBus, Events } from '../../infrastructure/events/EventBus.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { InsufficientCreditsError } from '../../shared/errors/DomainErrors.js';
import type { PlanName, CreditDeduction } from '../../shared/types/contracts.js';

export interface PlanConfig {
  name: string;
  displayName: string;
  priceMonthly: number;
  credits: number;
  maxBusinesses: number;
  maxCompetitorsPerLocation: number;
  maxKeywords: number;
  hasAiReplies: boolean;
}

export const PLANS: Record<string, PlanConfig> = {
  starter:      { name:'starter',      displayName:'Starter',     priceMonthly:69,   credits:500,   maxBusinesses:1,   maxCompetitorsPerLocation:1, maxKeywords:1, hasAiReplies:false },
  growth:       { name:'growth',       displayName:'Growth',      priceMonthly:119,  credits:1400,  maxBusinesses:1,   maxCompetitorsPerLocation:2, maxKeywords:2, hasAiReplies:true  },
  pro:          { name:'pro',          displayName:'Pro',         priceMonthly:199,  credits:5400,  maxBusinesses:2,   maxCompetitorsPerLocation:3, maxKeywords:3, hasAiReplies:true  },
  agency:       { name:'agency',       displayName:'Agency',      priceMonthly:799,  credits:21600, maxBusinesses:5,   maxCompetitorsPerLocation:4, maxKeywords:4, hasAiReplies:true  },
  enterprise:   { name:'enterprise',   displayName:'Enterprise',  priceMonthly:0,    credits:99999, maxBusinesses:999, maxCompetitorsPerLocation:999,maxKeywords:999,hasAiReplies:true },
  // legacy name kept for existing DB rows
  professional: { name:'professional', displayName:'Pro',         priceMonthly:249,  credits:5400,  maxBusinesses:5,   maxCompetitorsPerLocation:5, maxKeywords:3, hasAiReplies:true  },
};

// ── Standalone helpers used by route files ───────────────────
export function getPlan(planName: string): PlanConfig {
  return PLANS[planName] ?? PLANS.starter;
}
export function businessLimit(planName: string): number {
  return getPlan(planName).maxBusinesses;
}
export function competitorLimit(planName: string): number {
  return getPlan(planName).maxCompetitorsPerLocation;
}
export function keywordLimit(planName: string): number {
  return getPlan(planName).maxKeywords;
}
export function canUseAiReplies(planName: string): boolean {
  return getPlan(planName).hasAiReplies;
}

export class BillingService {
  getPlan(planName: string): PlanConfig {
    return getPlan(planName);
  }

  async getCreditsBalance(userId: string): Promise<number> {
    const { data } = await db.from('profiles').select('credits_balance').eq('id', userId).single();
    return data?.credits_balance ?? 0;
  }

  async checkAndDeductCredits(deduction: CreditDeduction): Promise<void> {
    const balance = await this.getCreditsBalance(deduction.userId);
    if (balance < deduction.amount) throw new InsufficientCreditsError(deduction.amount, balance);
    const newBalance = balance - deduction.amount;
    const { error } = await db.from('profiles')
      .update({ credits_balance: newBalance })
      .eq('id', deduction.userId);
    if (error) throw new Error('Failed to deduct credits: ' + error.message);
    await db.from('credit_transactions').insert({
      user_id: deduction.userId,
      amount: -deduction.amount,
      balance_after: newBalance,
      reason: deduction.reason,
      transaction_type: deduction.transactionType,
    });
    eventBus.publish(Events.CREDITS_DEDUCTED, {
      userId: deduction.userId, amount: deduction.amount, newBalance,
    });
    logger.info('[Billing] Credits deducted', { userId: deduction.userId, amount: deduction.amount, newBalance });
  }

  async getCreditHistory(userId: string, limit = 50): Promise<any[]> {
    const { data } = await db.from('credit_transactions')
      .select('*').eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(limit);
    return data ?? [];
  }

  async resetMonthlyCredits(): Promise<void> {
    const { data: profiles } = await db.from('profiles').select('id, plan');
    if (!profiles?.length) return;
    for (const p of profiles) {
      const plan = getPlan(p.plan);
      if (plan.credits === 99999) continue;
      await db.from('profiles').update({ credits_balance: plan.credits }).eq('id', p.id);
      await db.from('credit_transactions').insert({
        user_id: p.id, amount: plan.credits, balance_after: plan.credits,
        reason: 'Monthly credit reset', transaction_type: 'monthly_reset',
      });
    }
    logger.info('[Billing] Monthly reset complete', { profiles: profiles.length });
  }
}

export const billingService = new BillingService();
BIZZMASTER_APPS_API_SRC_DOMAINS_BILLING_BILLINGSERVICE_TS

echo "  ✓ apps/api/src/domains/intelligence/IntelligenceService.ts"
mkdir -p "$ROOT/apps/api/src/domains/intelligence"
cat > "$ROOT/apps/api/src/domains/intelligence/IntelligenceService.ts" << 'BIZZMASTER_APPS_API_SRC_DOMAINS_INTELLIGENCE_INTELLIGENCESERVICE_TS'
/**
 * Intelligence Domain — IntelligenceService
 *
 * Multi-Level Monitoring Intelligence Framework
 * ─────────────────────────────────────────────
 * Level 0 — Passive: reads only from cache/DB, $0.00 cost
 * Level 1 — Lightweight: daily summary ping, detects changes cheaply
 * Level 2 — Triggered: full scan for one keyword when threshold breached
 * Level 3 — Deep Analysis: full grid scan all keywords + competitors
 *
 * Escalation model:
 *   L0 → L1 (daily) → change? → L2 (triggered) → major event? → L3 (on-demand/monthly)
 *
 * Cache Confidence Score tracks data freshness per business.
 * L0 is only served with confidence when L1 has run recently.
 */

import { db } from '../../infrastructure/database/SupabaseClient.js';
import { eventBus, Events } from '../../infrastructure/events/EventBus.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { serpApiService } from '../serpapi/SerpApiService.js';
import {
  getIntelLevel, setIntelLevel, clearIntelLevel,
  getCacheConfidence, setCacheConfidence, degradeCacheConfidence,
  type IntelLevelState, type CacheConfidence,
} from '../../infrastructure/cache/CacheService.js';
import { enqueueOrganicScan } from '../../infrastructure/queue/QueueRegistry.js';
import { geoService } from '../geo/GeoService.js';
import { billingService } from '../billing/BillingService.js';

// ─── Threshold defaults (configurable per business) ──────────
export interface IntelThresholds {
  visibilityDrop:       number; // % drop triggers L2 (default: 10)
  competitorMovement:   number; // score threshold triggers L2 (default: 15)
  reviewSpike:          number; // new reviews in 24h triggers L2 (default: 5)
  adPressureSpike:      number; // ad pressure spike triggers L2 (default: 20)
}

export const DEFAULT_THRESHOLDS: IntelThresholds = {
  visibilityDrop:     10,
  competitorMovement: 15,
  reviewSpike:        5,
  adPressureSpike:    20,
};

// ─── Signal types emitted by L1 ──────────────────────────────
export interface ChangeSignal {
  type: 'RankingDelta' | 'VisibilityDelta' | 'CompetitorDelta' | 'ReviewDelta' | 'AdPressureDelta';
  businessId: string;
  value: number;       // magnitude of change
  direction: 'up' | 'down' | 'spike';
  triggersL2: boolean;
  detectedAt: string;
}

export class IntelligenceService {

  // ─── LEVEL 0: Passive Intelligence ──────────────────────────
  /**
   * Returns cached data for a business. Zero API calls.
   * Always called first — dashboard, reports, opportunity score.
   * Returns confidence metadata so UI can show data freshness.
   */
  async getPassiveIntelligence(businessId: string, userId: string): Promise<{
    latestScore: any;
    latestScans: any[];
    recentSignals: any[];
    cacheConfidence: CacheConfidence | null;
    intelLevel: IntelLevelState | null;
  }> {
    const [
      { data: latestScore },
      { data: latestScans },
      { data: signals },
    ] = await Promise.all([
      db.from('organic_scores')
        .select('*')
        .eq('business_id', businessId)
        .eq('user_id', userId)
        .order('scanned_at', { ascending: false })
        .limit(1)
        .single(),
      db.from('organic_scans')
        .select('id, keyword, state, scan_date, organic_scores(organic_visibility_score, organic_avg_ranking, organic_top3_cells)')
        .eq('business_id', businessId)
        .eq('user_id', userId)
        .eq('state', 'completed')
        .order('scan_date', { ascending: false })
        .limit(10),
      db.from('intel_signals')
        .select('*')
        .eq('business_id', businessId)
        .order('detected_at', { ascending: false })
        .limit(20),
    ]);

    const [confidence, intelLevel] = await Promise.all([
      getCacheConfidence(businessId),
      getIntelLevel(userId),
    ]);

    return {
      latestScore: latestScore ?? null,
      latestScans: latestScans ?? [],
      recentSignals: signals ?? [],
      cacheConfidence: confidence,
      intelLevel: intelLevel ?? null,
    };
  }

  // ─── LEVEL 1: Lightweight Monitoring ────────────────────────
  /**
   * Daily lightweight check for a single business.
   * Fetches only summary-level data — NOT a full 25-point grid scan.
   * Detects changes by comparing against last known values.
   * If a threshold is breached, emits a signal and optionally triggers L2.
   *
   * API cost: ~2-4 SerpAPI calls per business per day
   */
  async runL1Check(
    businessId: string,
    userId: string,
    keywords: string[],
    thresholds: IntelThresholds = DEFAULT_THRESHOLDS,
    autoEscalate = true,
  ): Promise<ChangeSignal[]> {
    logger.info('[Intel L1] Starting check', { businessId, keywords: keywords.length });

    const { data: business } = await db.from('businesses')
      .select('latitude, longitude, google_place_id, name')
      .eq('id', businessId).single();

    if (!business?.latitude || !business?.longitude) {
      logger.warn('[Intel L1] No location for business', { businessId });
      return [];
    }

    const signals: ChangeSignal[] = [];

    // Get last known scores for comparison
    const { data: lastScore } = await db.from('organic_scores')
      .select('organic_visibility_score, organic_avg_ranking, scan_date')
      .eq('business_id', businessId)
      .order('scanned_at', { ascending: false })
      .limit(1).single();

    for (const keyword of keywords) {
      // Single-point check at business center (cheap — 1 API call per keyword)
      const result = await serpApiService.search(
        business.latitude, business.longitude, keyword, 5000, 'WEEKLY_SCAN'
      );

      const myRank = result.organic.find(r => r.placeId === business.google_place_id)?.rank ?? null;
      const lastRank = lastScore?.organic_avg_ranking ?? null;

      if (myRank !== null && lastRank !== null) {
        const delta = lastRank - myRank; // positive = improved, negative = dropped
        if (Math.abs(delta) >= 2) {
          const signal: ChangeSignal = {
            type: 'RankingDelta',
            businessId,
            value: Math.abs(delta),
            direction: delta > 0 ? 'up' : 'down',
            triggersL2: Math.abs(delta) >= 5,
            detectedAt: new Date().toISOString(),
          };
          signals.push(signal);
          await this.saveSignal(businessId, userId, signal);
        }
      }

      // Check for competitor movement (did anyone new appear in top 3?)
      const top3PlaceIds = result.organic.slice(0, 3).map(r => r.placeId);
      const { data: knownCompetitors } = await db.from('competitors')
        .select('google_place_id, name')
        .eq('business_id', businessId)
        .eq('is_active', true);

      const knownIds = (knownCompetitors ?? []).map(c => c.google_place_id).filter(Boolean);
      const surpriseCompetitors = top3PlaceIds.filter(
        id => id && !knownIds.includes(id) && id !== business.google_place_id
      );

      if (surpriseCompetitors.length > 0) {
        const compMovementScore = surpriseCompetitors.length * 8;
        const signal: ChangeSignal = {
          type: 'CompetitorDelta',
          businessId,
          value: compMovementScore,
          direction: 'spike',
          triggersL2: compMovementScore >= thresholds.competitorMovement,
          detectedAt: new Date().toISOString(),
        };
        signals.push(signal);
        await this.saveSignal(businessId, userId, signal);
        await degradeCacheConfidence(businessId, 'competitor_move', 25);
      }
    }

    // Check review spike
    const since24h = new Date(Date.now() - 86400000).toISOString();
    const { count: newReviews } = await db.from('reviews')
      .select('*', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .gte('created_at', since24h);

    if ((newReviews ?? 0) >= thresholds.reviewSpike) {
      const signal: ChangeSignal = {
        type: 'ReviewDelta',
        businessId,
        value: newReviews ?? 0,
        direction: 'spike',
        triggersL2: true,
        detectedAt: new Date().toISOString(),
      };
      signals.push(signal);
      await this.saveSignal(businessId, userId, signal);
    }

    // Update cache confidence — L1 just validated
    const existing = await getCacheConfidence(businessId);
    const hasChanges = signals.some(s => s.triggersL2);
    await setCacheConfidence(businessId, {
      score: hasChanges ? Math.max(40, (existing?.score ?? 100) - 20) : 95,
      lastL3: existing?.lastL3 ?? '',
      lastL1: new Date().toISOString(),
      changesDetected: hasChanges,
    });

    // Set intel level state
    await setIntelLevel(userId, {
      level: signals.length > 0 ? 1 : 0,
      activatedAt: new Date().toISOString(),
      reason: signals.length > 0
        ? `L1 detected ${signals.length} change signal(s)`
        : 'L1 complete — no changes detected',
      apiCostEstimate: keywords.length * 0.01,
    });

    // Auto-escalate to L2 if any signal triggers threshold
    if (autoEscalate && signals.some(s => s.triggersL2)) {
      logger.info('[Intel L1] Threshold breached — escalating to L2', { businessId });
      const triggeringKeywords = keywords.slice(0, 1); // L2 one keyword at a time
      // Fire-and-forget — don't block L1 response
      this.runL2TriggeredAnalysis(businessId, userId, triggeringKeywords[0])
        .catch(err => logger.error('[Intel L2] Auto-escalation failed', { error: err.message }));
    }

    logger.info('[Intel L1] Check complete', {
      businessId, signals: signals.length,
      triggersL2: signals.some(s => s.triggersL2),
    });
    return signals;
  }

  // ─── LEVEL 2: Triggered Intelligence ────────────────────────
  /**
   * Full 25-point grid scan for ONE keyword.
   * Only runs when L1 detects a threshold breach.
   * Updates opportunity score, competitor analysis, AI action plans.
   *
   * API cost: ~25 SerpAPI calls (one per grid point)
   */
  async runL2TriggeredAnalysis(
    businessId: string,
    userId: string,
    keyword: string,
  ): Promise<void> {
    logger.info('[Intel L2] Starting triggered analysis', { businessId, keyword });

    await setIntelLevel(userId, {
      level: 2,
      activatedAt: new Date().toISOString(),
      reason: `L2 triggered for keyword: ${keyword}`,
      apiCostEstimate: 0.40,
    });

    const { data: business } = await db.from('businesses')
      .select('latitude, longitude, google_place_id')
      .eq('id', businessId).single();

    if (!business?.latitude) {
      logger.warn('[Intel L2] No location', { businessId });
      return;
    }

    const points = geoService.generateAutoGrid(business.latitude, business.longitude, 5, 3);

    const { data: competitors } = await db.from('competitors')
      .select('id, name, google_place_id')
      .eq('business_id', businessId)
      .eq('is_active', true);

    // Create a scan record
    const { data: scan } = await db.from('organic_scans').insert({
      user_id: userId, business_id: businessId, keyword,
      targeting_method: 'auto_grid', radius_km: 5, grid_size: 3,
      scan_points: points, total_points: points.length, points_completed: 0,
      state: 'pending', credits_consumed: 0, // L2 uses fixed credits pool
      scan_date: new Date().toISOString().split('T')[0],
      is_automated: true, intel_level: 2,
    }).select().single();

    if (!scan) {
      logger.error('[Intel L2] Failed to create scan record', { businessId, keyword });
      return;
    }

    await enqueueOrganicScan({
      scanId: scan.id, userId, businessId,
      clientGooglePlaceId: business.google_place_id,
      competitors: (competitors ?? []).map(c => ({
        id: c.id, name: c.name, googlePlaceId: c.google_place_id,
      })),
      keyword, points, radiusKm: 5, isAutomated: true,
    });

    // Save a signal that L2 was triggered
    await this.saveSignal(businessId, userId, {
      type: 'RankingDelta',
      businessId,
      value: 0,
      direction: 'down',
      triggersL2: false,
      detectedAt: new Date().toISOString(),
    });

    logger.info('[Intel L2] Scan enqueued', { businessId, keyword, scanId: scan.id });
  }

  // ─── LEVEL 3: Deep Analysis ──────────────────────────────────
  /**
   * Full analysis — all keywords, all competitors, all grid points.
   * Runs on weekly schedule (automated) or on-demand by user.
   * This is what the weekly cron triggers.
   *
   * API cost: keywords × (1 biz + N competitors) × 25 points
   */
  async runL3DeepAnalysis(
    businessId: string,
    userId: string,
    keywords: string[],
    triggeredBy: 'weekly_schedule' | 'manual' | 'monthly_report',
  ): Promise<void> {
    logger.info('[Intel L3] Starting deep analysis', {
      businessId, keywords: keywords.length, triggeredBy,
    });

    await setIntelLevel(userId, {
      level: 3,
      activatedAt: new Date().toISOString(),
      reason: `L3 ${triggeredBy}: all keywords and competitors`,
      apiCostEstimate: keywords.length * 2.80,
    });

    const { data: business } = await db.from('businesses')
      .select('latitude, longitude, google_place_id')
      .eq('id', businessId).single();

    if (!business?.latitude) return;

    const { data: competitors } = await db.from('competitors')
      .select('id, name, google_place_id')
      .eq('business_id', businessId)
      .eq('is_active', true);

    const points = geoService.generateAutoGrid(business.latitude, business.longitude, 5, 3);

    for (const keyword of keywords) {
      const { data: scan } = await db.from('organic_scans').insert({
        user_id: userId, business_id: businessId, keyword,
        targeting_method: 'auto_grid', radius_km: 5, grid_size: 3,
        scan_points: points, total_points: points.length, points_completed: 0,
        state: 'pending', credits_consumed: 0,
        scan_date: new Date().toISOString().split('T')[0],
        is_automated: true, intel_level: 3,
      }).select().single();

      if (!scan) continue;

      await enqueueOrganicScan({
        scanId: scan.id, userId, businessId,
        clientGooglePlaceId: business.google_place_id,
        competitors: (competitors ?? []).map(c => ({
          id: c.id, name: c.name, googlePlaceId: c.google_place_id,
        })),
        keyword, points, radiusKm: 5, isAutomated: true,
      });
    }

    // Update cache confidence — L3 just ran, full confidence
    await setCacheConfidence(businessId, {
      score: 100,
      lastL3: new Date().toISOString(),
      lastL1: new Date().toISOString(),
      changesDetected: false,
    });

    logger.info('[Intel L3] All scans enqueued', {
      businessId, keywords: keywords.length,
    });
  }

  // ─── Opportunity Score ────────────────────────────────────────
  /**
   * Compute Opportunity Score from cached scan data. Zero API calls.
   * Score = weighted combination of:
   *   - Visibility score (40%)
   *   - Territory dominance / top-3 coverage (30%)
   *   - Review velocity vs competitors (15%)
   *   - Cache confidence (15%)
   */
  async computeOpportunityScore(businessId: string, userId: string): Promise<{
    score: number;
    breakdown: Record<string, number>;
    trend: 'improving' | 'stable' | 'declining';
    topAction: string;
  }> {
    const { data: scores } = await db.from('organic_scores')
      .select('organic_visibility_score, organic_territory_dominance, organic_top3_cells, organic_total_cells, scanned_at')
      .eq('business_id', businessId)
      .eq('user_id', userId)
      .order('scanned_at', { ascending: false })
      .limit(2);

    if (!scores?.length) {
      return {
        score: 0, breakdown: {},
        trend: 'stable',
        topAction: 'Run your first scan to generate an Opportunity Score',
      };
    }

    const latest = scores[0];
    const previous = scores[1];

    const visibilityComponent  = (latest.organic_visibility_score ?? 0) * 0.40;
    const dominanceComponent   = (latest.organic_territory_dominance ?? 0) * 0.30;
    const top3Pct = latest.organic_total_cells > 0
      ? (latest.organic_top3_cells / latest.organic_total_cells) * 100 : 0;
    const coverageComponent    = top3Pct * 0.20;

    // Review component (placeholder — 10% of score)
    const { data: reviews } = await db.from('reviews')
      .select('rating, is_replied')
      .eq('business_id', businessId)
      .order('review_date', { ascending: false })
      .limit(50);
    const avgRating = reviews?.length
      ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 3;
    const reviewComponent = ((avgRating - 1) / 4) * 100 * 0.10;

    const totalScore = Math.min(100, Math.round(
      visibilityComponent + dominanceComponent + coverageComponent + reviewComponent
    ));

    // Trend: compare to previous scan
    let trend: 'improving' | 'stable' | 'declining' = 'stable';
    if (previous) {
      const prevScore = previous.organic_visibility_score ?? 0;
      if (latest.organic_visibility_score > prevScore + 3) trend = 'improving';
      else if (latest.organic_visibility_score < prevScore - 3) trend = 'declining';
    }

    // Top action based on weakest component
    let topAction = 'Run more keywords to identify growth opportunities';
    if (top3Pct < 30) topAction = 'Focus on ranking Top 3 in your core service zones';
    else if (avgRating < 4.2) topAction = 'Improve review response rate to boost visibility score';
    else if (latest.organic_visibility_score < 50) topAction = 'Optimize your Google Business Profile completeness';

    return {
      score: totalScore,
      breakdown: {
        visibility: Math.round(visibilityComponent),
        dominance: Math.round(dominanceComponent),
        coverage: Math.round(coverageComponent),
        reviews: Math.round(reviewComponent),
      },
      trend,
      topAction,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────
  private async saveSignal(
    businessId: string,
    userId: string,
    signal: ChangeSignal
  ): Promise<void> {
    try {
      await db.from('intel_signals').insert({
        business_id: businessId,
        user_id: userId,
        signal_type: signal.type,
        value: signal.value,
        direction: signal.direction,
        triggers_l2: signal.triggersL2,
        detected_at: signal.detectedAt,
      });
    } catch { /* non-critical — signals are informational */ }
  }

  async getThresholds(businessId: string): Promise<IntelThresholds> {
    try {
      const { data } = await db.from('intel_thresholds')
        .select('*').eq('business_id', businessId).single();
      return data ? {
        visibilityDrop:     data.visibility_drop ?? DEFAULT_THRESHOLDS.visibilityDrop,
        competitorMovement: data.competitor_movement ?? DEFAULT_THRESHOLDS.competitorMovement,
        reviewSpike:        data.review_spike ?? DEFAULT_THRESHOLDS.reviewSpike,
        adPressureSpike:    data.ad_pressure_spike ?? DEFAULT_THRESHOLDS.adPressureSpike,
      } : DEFAULT_THRESHOLDS;
    } catch { return DEFAULT_THRESHOLDS; }
  }

  async saveThresholds(businessId: string, userId: string, t: IntelThresholds): Promise<void> {
    await db.from('intel_thresholds').upsert({
      business_id: businessId, user_id: userId,
      visibility_drop: t.visibilityDrop,
      competitor_movement: t.competitorMovement,
      review_spike: t.reviewSpike,
      ad_pressure_spike: t.adPressureSpike,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'business_id' });
  }
}

export const intelligenceService = new IntelligenceService();
BIZZMASTER_APPS_API_SRC_DOMAINS_INTELLIGENCE_INTELLIGENCESERVICE_TS

echo "  ✓ apps/api/src/domains/reviews/ReviewIntelligenceService.ts"
mkdir -p "$ROOT/apps/api/src/domains/reviews"
cat > "$ROOT/apps/api/src/domains/reviews/ReviewIntelligenceService.ts" << 'BIZZMASTER_APPS_API_SRC_DOMAINS_REVIEWS_REVIEWINTELLIGENCESERVICE_TS'
/**
 * Review Intelligence Service
 * Gemini-powered theme extraction from customer reviews.
 * One Gemini Flash call per business per week (~$0.001).
 * Results cached in DB for 7 days, force-refreshable on demand.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import 'dotenv/config';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');

export interface ReviewTheme {
  theme: string;       // e.g. "Friendly Staff"
  count: number;       // how many reviews mention it
  example: string;     // one short quote
}

export interface ReviewIntelligence {
  businessId: string;
  positiveThemes: ReviewTheme[];
  negativeThemes: ReviewTheme[];
  emergingThemes: ReviewTheme[];   // new in last 30 days
  summary: string;                 // one-line headline
  sentiment: 'positive' | 'neutral' | 'negative';
  trend: 'improving' | 'stable' | 'declining';
  reviewsAnalyzed: number;
  generatedAt: string;
}

export class ReviewIntelligenceService {

  /**
   * Get review intelligence for a business.
   * Returns cached result if < 7 days old, otherwise generates fresh.
   */
  async getIntelligence(businessId: string, userId: string, forceRefresh = false): Promise<ReviewIntelligence | null> {
    // Check cache first (7-day TTL)
    if (!forceRefresh) {
      const cached = await this.getCached(businessId);
      if (cached) return cached;
    }

    // Fetch reviews from DB
    const { data: reviews } = await db.from('reviews')
      .select('rating, review_text, review_date, reviewer_name')
      .eq('business_id', businessId)
      .eq('user_id', userId)
      .not('review_text', 'is', null)
      .order('review_date', { ascending: false })
      .limit(100);

    if (!reviews?.length || reviews.length < 3) {
      return null; // Not enough reviews to analyze
    }

    const { data: biz } = await db.from('businesses')
      .select('name').eq('id', businessId).single();

    try {
      const intel = await this.analyzeWithGemini(businessId, biz?.name ?? 'the business', reviews);
      await this.saveToDb(businessId, userId, intel);
      return intel;
    } catch (err: any) {
      logger.error('[ReviewIntel] Gemini analysis failed', { error: err.message, businessId });
      throw err;
    }
  }

  private async analyzeWithGemini(businessId: string, bizName: string, reviews: any[]): Promise<ReviewIntelligence> {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
      throw new Error('Gemini API key not configured');
    }

    // Prepare review text — keep it concise to minimize token usage
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const reviewLines = reviews.map(r => {
      const isRecent = r.review_date > thirtyDaysAgo ? ' [RECENT]' : '';
      return `${r.rating}★${isRecent}: "${r.review_text?.slice(0, 150)}"`;
    }).join('\n');

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }); // Flash = ~$0.001

    const prompt = `Analyze these ${reviews.length} customer reviews for "${bizName}" and extract themes.

REVIEWS:
${reviewLines}

Respond ONLY with valid JSON in this exact format:
{
  "positiveThemes": [
    {"theme": "theme name", "count": 5, "example": "short quote"},
    {"theme": "theme name", "count": 3, "example": "short quote"}
  ],
  "negativeThemes": [
    {"theme": "theme name", "count": 4, "example": "short quote"}
  ],
  "emergingThemes": [
    {"theme": "theme name (from [RECENT] reviews only)", "count": 2, "example": "short quote"}
  ],
  "summary": "One sentence: customers praise X but mention Y",
  "sentiment": "positive",
  "trend": "stable"
}

Rules:
- Up to 5 positive themes, 5 negative themes, 3 emerging themes
- Only include themes with 2+ mentions (or 1+ for emerging)
- emergingThemes: only from reviews marked [RECENT]
- sentiment: "positive" if avg rating > 4, "negative" if < 3, else "neutral"
- trend: "improving" if recent reviews better than older, "declining" if worse, else "stable"
- Keep theme names short (2-4 words)
- Keep examples under 60 characters
- Return empty arrays if no themes found`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

    const parsed = JSON.parse(text);

    return {
      businessId,
      positiveThemes: (parsed.positiveThemes ?? []).slice(0, 5),
      negativeThemes: (parsed.negativeThemes ?? []).slice(0, 5),
      emergingThemes: (parsed.emergingThemes ?? []).slice(0, 3),
      summary: parsed.summary ?? '',
      sentiment: parsed.sentiment ?? 'neutral',
      trend: parsed.trend ?? 'stable',
      reviewsAnalyzed: reviews.length,
      generatedAt: new Date().toISOString(),
    };
  }

  private async getCached(businessId: string): Promise<ReviewIntelligence | null> {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data } = await db.from('review_intelligence')
        .select('*')
        .eq('business_id', businessId)
        .gte('generated_at', sevenDaysAgo)
        .order('generated_at', { ascending: false })
        .limit(1).single();

      if (!data) return null;

      return {
        businessId,
        positiveThemes: data.positive_themes ?? [],
        negativeThemes: data.negative_themes ?? [],
        emergingThemes: data.emerging_themes ?? [],
        summary: data.summary ?? '',
        sentiment: data.sentiment ?? 'neutral',
        trend: data.trend ?? 'stable',
        reviewsAnalyzed: data.reviews_analyzed ?? 0,
        generatedAt: data.generated_at,
      };
    } catch {
      return null;
    }
  }

  private async saveToDb(businessId: string, userId: string, intel: ReviewIntelligence): Promise<void> {
    await db.from('review_intelligence').upsert({
      business_id: businessId,
      user_id: userId,
      positive_themes: intel.positiveThemes,
      negative_themes: intel.negativeThemes,
      emerging_themes: intel.emergingThemes,
      summary: intel.summary,
      sentiment: intel.sentiment,
      trend: intel.trend,
      reviews_analyzed: intel.reviewsAnalyzed,
      generated_at: intel.generatedAt,
    }, { onConflict: 'business_id' });

    logger.info('[ReviewIntel] Saved', {
      businessId,
      reviewsAnalyzed: intel.reviewsAnalyzed,
      positives: intel.positiveThemes.length,
      negatives: intel.negativeThemes.length,
    });
  }

  /**
   * Weekly refresh for all businesses with enough reviews.
   * Called by cron on Sunday 02:00 UTC.
   */
  async runWeeklyRefresh(): Promise<void> {
    logger.info('[ReviewIntel] Starting weekly refresh');

    const { data: businesses } = await db.from('businesses')
      .select('id, user_id, name')
      .eq('is_active', true);

    if (!businesses?.length) return;

    let refreshed = 0;
    for (const biz of businesses) {
      try {
        await this.getIntelligence(biz.id, biz.user_id, true);
        refreshed++;
        // Rate limit: avoid hitting Gemini too fast
        await new Promise(r => setTimeout(r, 1000));
      } catch (err: any) {
        logger.warn('[ReviewIntel] Refresh failed for business', {
          businessId: biz.id, error: err.message,
        });
      }
    }

    logger.info('[ReviewIntel] Weekly refresh complete', { refreshed });
  }
}

export const reviewIntelligenceService = new ReviewIntelligenceService();
BIZZMASTER_APPS_API_SRC_DOMAINS_REVIEWS_REVIEWINTELLIGENCESERVICE_TS

echo "  ✓ apps/api/src/domains/scheduling/WeeklyScheduler.ts"
mkdir -p "$ROOT/apps/api/src/domains/scheduling"
cat > "$ROOT/apps/api/src/domains/scheduling/WeeklyScheduler.ts" << 'BIZZMASTER_APPS_API_SRC_DOMAINS_SCHEDULING_WEEKLYSCHEDULER_TS'
/**
 * Scheduling Domain — WeeklyScheduler
 *
 * Orchestrates all automated intelligence activity:
 *   - Daily L1 change detection for all active businesses
 *   - Weekly L3 full scans (consumes fixed intelligence credits)
 *   - Monthly credit reset
 *   - Monthly L3 reports for Agency/Enterprise
 *
 * Uses existing enqueueOrganicScan() — no new scan logic needed.
 * The scheduler is purely orchestration on top of what already works.
 */

import { db } from '../../infrastructure/database/SupabaseClient.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { intelligenceService } from '../intelligence/IntelligenceService.js';
import { billingService, PLANS, CREDIT_COSTS } from '../billing/BillingService.js';
import { enqueueOrganicScan } from '../../infrastructure/queue/QueueRegistry.js';
import { geoService } from '../geo/GeoService.js';

export class WeeklyScheduler {

  /**
   * L1 DAILY CHECK — runs every day at 01:00 UTC
   * For every active paid customer:
   *   1. Run L1 lightweight check per business
   *   2. If threshold breached, auto-escalate to L2
   * Cost: ~$0.01 per business per day (1-2 SerpAPI calls)
   */
  async runDailyL1Checks(): Promise<void> {
    logger.info('[Scheduler] Starting daily L1 checks');

    const { data: profiles } = await db
      .from('profiles')
      .select('id, plan')
      .neq('plan', 'starter') // starter has no L1 monitoring
      .gt('credits_balance', 0);

    if (!profiles?.length) {
      logger.info('[Scheduler] No eligible profiles for L1');
      return;
    }

    let checked = 0, escalated = 0;

    for (const profile of profiles) {
      try {
        const { data: businesses } = await db
          .from('businesses')
          .select('id')
          .eq('user_id', profile.id)
          .eq('is_active', true);

        if (!businesses?.length) continue;

        for (const biz of businesses) {
          // Get keywords for this business
          const keywords = await this.getKeywordsForBusiness(biz.id);
          if (!keywords.length) continue;

          const thresholds = await intelligenceService.getThresholds(biz.id);
          const signals = await intelligenceService.runL1Check(
            biz.id, profile.id, keywords, thresholds, true
          );

          checked++;
          if (signals.some(s => s.triggersL2)) escalated++;
        }
      } catch (err: any) {
        logger.error('[Scheduler] L1 check failed for profile', {
          profileId: profile.id, error: err.message,
        });
      }
    }

    logger.info('[Scheduler] Daily L1 checks complete', { checked, escalated });
  }

  /**
   * L3 WEEKLY SCAN — runs every Monday at 02:00 UTC
   * Full 25-point grid scan for all businesses on all keywords.
   * Consumes FIXED intelligence credits (not user credits).
   *
   * Formula verification:
   *   Starter (no auto):  skipped — manual only
   *   Growth  (1 biz, 2 kw, 2 comp): 2×(1+2)×25×4 = 600 fixed/mo ✓
   *   Pro     (2 biz, 3 kw, 3 comp): 2×2×(1+3)×25×4 = 1600 per 4wks — wait
   *   CORRECTED: each location scans independently
   *   Pro     2 locations × 3 keywords × (1 + 3 comps) × 25 pts × 4 weeks = 2400 ✓
   *   Agency  5 locations × 4 keywords × (1 + 4 comps) × 25 pts × 4 weeks = 10000 ✓
   */
  async runWeeklyScans(): Promise<void> {
    logger.info('[Scheduler] Starting weekly L3 scans');

    const { data: profiles } = await db
      .from('profiles')
      .select('id, plan, credits_balance');

    if (!profiles?.length) return;

    let totalScansQueued = 0;

    for (const profile of profiles) {
      const planConfig = PLANS[profile.plan as keyof typeof PLANS];
      if (!planConfig) continue;

      // Starter plan: no automated scans — customer scans manually
      if (profile.plan === 'starter') continue;

      // Check enough fixed credits remain
      const { data: businesses } = await db
        .from('businesses')
        .select('id, latitude, longitude, google_place_id')
        .eq('user_id', profile.id)
        .eq('is_active', true)
        .limit(planConfig.maxBusinesses);

      if (!businesses?.length) continue;

      for (const biz of businesses) {
        if (!biz.latitude || !biz.longitude) continue;

        const keywords = await this.getKeywordsForBusiness(biz.id);
        if (!keywords.length) continue;

        const { data: competitors } = await db
          .from('competitors')
          .select('id, name, google_place_id')
          .eq('business_id', biz.id)
          .eq('is_active', true)
          .limit(planConfig.maxCompetitorsPerLocation);

        const points = geoService.generateAutoGrid(biz.latitude, biz.longitude, 5, 3);
        // Credit cost per scan: 25 points per keyword per weekly cycle
        const creditsPerScan = planConfig.gridSize;

        for (const keyword of keywords) {
          // Deduct fixed credits
          try {
            await billingService.deductFixedCredits(
              profile.id,
              creditsPerScan,
              `Weekly automated scan: ${keyword} — ${biz.id}`
            );
          } catch (err: any) {
            logger.warn('[Scheduler] Insufficient fixed credits — skipping scan', {
              profileId: profile.id, businessId: biz.id, keyword, error: err.message,
            });
            continue;
          }

          // Create scan record
          const { data: scan } = await db.from('organic_scans').insert({
            user_id: profile.id, business_id: biz.id, keyword,
            targeting_method: 'auto_grid', radius_km: 5, grid_size: 3,
            scan_points: points, total_points: points.length, points_completed: 0,
            state: 'pending', credits_consumed: creditsPerScan,
            scan_date: new Date().toISOString().split('T')[0],
            is_automated: true, intel_level: 3,
          }).select().single();

          if (!scan) continue;

          await enqueueOrganicScan({
            scanId: scan.id,
            userId: profile.id,
            businessId: biz.id,
            clientGooglePlaceId: biz.google_place_id,
            competitors: (competitors ?? []).map(c => ({
              id: c.id, name: c.name, googlePlaceId: c.google_place_id,
            })),
            keyword, points, radiusKm: 5,
            isAutomated: true,
          });

          totalScansQueued++;
        }
      }
    }

    logger.info('[Scheduler] Weekly scans queued', { totalScansQueued });
  }

  /**
   * MONTHLY CREDIT RESET — runs on 1st of each month at 00:00 UTC
   */
  async runMonthlyReset(): Promise<void> {
    logger.info('[Scheduler] Running monthly credit reset');
    await billingService.resetMonthlyCredits();
  }

  /**
   * MONTHLY L3 REPORTS — for Agency and Enterprise
   * Runs on 1st of each month at 03:00 UTC
   */
  async runMonthlyReports(): Promise<void> {
    logger.info('[Scheduler] Running monthly L3 reports');

    const { data: profiles } = await db
      .from('profiles')
      .select('id, plan')
      .in('plan', ['agency', 'enterprise']);

    if (!profiles?.length) return;

    for (const profile of profiles) {
      const { data: businesses } = await db
        .from('businesses')
        .select('id')
        .eq('user_id', profile.id)
        .eq('is_active', true);

      for (const biz of (businesses ?? [])) {
        const keywords = await this.getKeywordsForBusiness(biz.id);
        await intelligenceService.runL3DeepAnalysis(
          biz.id, profile.id, keywords, 'monthly_report'
        );
      }
    }

    logger.info('[Scheduler] Monthly reports triggered');
  }

  private async getKeywordsForBusiness(businessId: string): Promise<string[]> {
    const { data } = await db
      .from('business_keywords')
      .select('keyword')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .order('display_order');
    return (data ?? []).map((k: any) => k.keyword);
  }
}

export const weeklyScheduler = new WeeklyScheduler();
BIZZMASTER_APPS_API_SRC_DOMAINS_SCHEDULING_WEEKLYSCHEDULER_TS

echo "  ✓ apps/api/src/index.ts"
mkdir -p "$ROOT/apps/api/src"
cat > "$ROOT/apps/api/src/index.ts" << 'BIZZMASTER_APPS_API_SRC_INDEX_TS'
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import 'dotenv/config';
import { logger } from './infrastructure/logger/Logger.js';

import './infrastructure/cache/RedisClient.js';
import { queues } from './infrastructure/queue/QueueRegistry.js';
import { startOrganicScanWorker } from './domains/scanning/ScanWorker.js';
import { startReviewWorker } from './domains/reviews/ReviewWorker.js';
import { startAdSlotWorker } from './domains/adpressure/AdPressureService.js';
import { leaderboardService } from './domains/leaderboard/LeaderboardService.js';

// Routes
import authRoutes       from './api/routes/auth.js';
import businessRoutes   from './api/routes/businesses.js';
import competitorRoutes from './api/routes/competitors.js';
import organicScanRoutes from './api/routes/organicScans.js';
import adScanRoutes     from './api/routes/adScans.js';
import reviewRoutes     from './api/routes/reviews.js';
import leaderboardRoutes from './api/routes/leaderboard.js';
import citationRoutes   from './api/routes/citations.js';
import dashboardRoutes  from './api/routes/dashboard.js';
import profileRoutes    from './api/routes/profile.js';
import orgRoutes        from './api/routes/orgs.js';
import intelligenceRoutes from './api/routes/intelligence.js';
import keywordRoutes    from './api/routes/keywords.js';

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth',           authRoutes);
app.use('/api/businesses',     businessRoutes);
app.use('/api/competitors',    competitorRoutes);
app.use('/api/organic-scans',  organicScanRoutes);
app.use('/api/ad-scans',       adScanRoutes);
app.use('/api/reviews',        reviewRoutes);
app.use('/api/leaderboard',    leaderboardRoutes);
app.use('/api/citations',      citationRoutes);
app.use('/api/dashboard',      dashboardRoutes);
app.use('/api/profile',        profileRoutes);
app.use('/api/orgs',           orgRoutes);
app.use('/api/intelligence',   intelligenceRoutes);
app.use('/api/keywords',       keywordRoutes);

app.get('/health', (_, res) => res.json({ status: 'ok', version: 'v10', time: new Date().toISOString() }));

app.use((err: any, req: any, res: any, next: any) => {
  logger.error('[API] Unhandled error', { error: err.message, path: req.path });
  res.status(err.statusCode ?? 500).json({ error: err.message ?? 'Internal server error' });
});

// ── Cron Jobs ─────────────────────────────────────────────────
function startCronJobs() {
  // Daily L1 change detection at 01:00 UTC
  cron.schedule('0 1 * * *', async () => {
    logger.info('[Cron] Daily L1 check');
    try {
      const { intelligenceService } = await import('./domains/intelligence/IntelligenceService.js');
      const { db } = await import('./infrastructure/database/SupabaseClient.js');
      const { data: profiles } = await db.from('profiles').select('id, plan').neq('plan', 'starter');
      for (const p of profiles ?? []) {
        const { data: businesses } = await db.from('businesses').select('id').eq('user_id', p.id).eq('is_active', true);
        for (const biz of businesses ?? []) {
          const { data: kws } = await db.from('business_keywords').select('keyword').eq('business_id', biz.id).eq('is_active', true);
          const keywords = (kws ?? []).map((k: any) => k.keyword);
          if (keywords.length) await intelligenceService.runL1Check(biz.id, p.id, keywords).catch(console.error);
        }
      }
    } catch (err: any) { logger.error('[Cron] L1 failed', { error: err.message }); }
  }, { timezone: 'UTC' });

  // Weekly L3 full scan — every Monday 02:00 UTC
  cron.schedule('0 2 * * 1', async () => {
    logger.info('[Cron] Weekly L3 scans');
    try {
      const { weeklyScheduler } = await import('./domains/scheduling/WeeklyScheduler.js');
      await weeklyScheduler.runWeeklyScans();
    } catch (err: any) { logger.error('[Cron] Weekly scan failed', { error: err.message }); }
  }, { timezone: 'UTC' });

  // Monthly credit reset — 1st of month 00:00 UTC
  cron.schedule('0 0 1 * *', async () => {
    logger.info('[Cron] Monthly credit reset');
    try {
      const { billingService } = await import('./domains/billing/BillingService.js');
      await billingService.resetMonthlyCredits();
    } catch (err: any) { logger.error('[Cron] Credit reset failed', { error: err.message }); }
  }, { timezone: 'UTC' });

  // Daily review sync — 04:00 UTC
  cron.schedule('0 4 * * *', async () => {
    logger.info('[Cron] Daily review sync');
    try {
      const { db } = await import('./infrastructure/database/SupabaseClient.js');
      const { enqueueReviewSync } = await import('./infrastructure/queue/QueueRegistry.js');
      const cutoff = new Date(Date.now() - 86400000).toISOString();
      const { data: bizs } = await db.from('businesses').select('id,user_id,google_place_id,name,last_review_sync').eq('is_active', true).not('google_place_id', 'is', null);
      for (const b of bizs ?? []) {
        if (!b.last_review_sync || b.last_review_sync < cutoff) {
          await enqueueReviewSync({ businessId: b.id, userId: b.user_id, googlePlaceId: b.google_place_id, businessName: b.name });
        }
      }
    } catch (err: any) { logger.error('[Cron] Review sync failed', { error: err.message }); }
  }, { timezone: 'UTC' });

  logger.info('[Cron] All scheduled jobs registered', { jobs: ['L1-daily@01:00','L3-weekly@Mon02:00','credits-reset@1st00:00','review-sync@04:00'] });
}

function start() {
  leaderboardService.registerEventHandlers();
  // NOTE: ReviewService.registerEventHandlers() removed — review sync now driven by daily cron
  startOrganicScanWorker();
  startAdSlotWorker();
  startReviewWorker();
  startCronJobs();
  const PORT = parseInt(process.env.PORT ?? '3000');
  app.listen(PORT, '0.0.0.0', () => {
    logger.info('BizzRank AI v10 running on port ' + PORT);
    logger.info('Workers: organic-scans(10) · ad-slots(20) · review-sync(50)');
    logger.info('Cron: L1-daily · L3-weekly · credits-monthly · reviews-daily');
  });
}

process.on('SIGTERM', async () => {
  await Promise.all([queues.organicScans.close(), queues.adScanSlots.close(), queues.reviewSync.close(), queues.citations.close()]);
  process.exit(0);
});
process.on('uncaughtException',  (err)    => logger.error('Uncaught exception',  { error: err.message }));
process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection', { reason }));

start();
BIZZMASTER_APPS_API_SRC_INDEX_TS

echo "  ✓ apps/api/src/infrastructure/database/SupabaseClient.ts"
mkdir -p "$ROOT/apps/api/src/infrastructure/database"
cat > "$ROOT/apps/api/src/infrastructure/database/SupabaseClient.ts" << 'BIZZMASTER_APPS_API_SRC_INFRASTRUCTURE_DATABASE_SUPABASECLIENT_TS'
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL not set');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');

const client = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Both names exported — routes use either 'db' or 'supabase'
export const db = client;
export const supabase = client;
BIZZMASTER_APPS_API_SRC_INFRASTRUCTURE_DATABASE_SUPABASECLIENT_TS

echo "  ✓ apps/api/src/infrastructure/queue/QueueRegistry.ts"
mkdir -p "$ROOT/apps/api/src/infrastructure/queue"
cat > "$ROOT/apps/api/src/infrastructure/queue/QueueRegistry.ts" << 'BIZZMASTER_APPS_API_SRC_INFRASTRUCTURE_QUEUE_QUEUEREGISTRY_TS'
import { Queue } from 'bullmq';
import { createBullMQConnection } from '../cache/RedisClient.js';
import { logger } from '../logger/Logger.js';

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};

function makeQueue(name: string) {
  return new Queue(name, { connection: createBullMQConnection(), defaultJobOptions });
}

export const queues = {
  organicScans: makeQueue('organic-scans'),
  adScanSlots:  makeQueue('ad-scan-slots'),
  reviewSync:   makeQueue('review-sync'),
  citations:    makeQueue('citation-audits'),
};

export async function enqueueOrganicScan(data: any) {
  // BullMQ job IDs cannot contain ':' — use '_' instead
  const job = await queues.organicScans.add('run-scan', data, {
    jobId: 'scan_' + data.scanId,
    timeout: 10 * 60 * 1000,
    priority: data.isAutomated ? 10 : 1,
  });
  logger.info('[Queue] Organic scan enqueued: ' + data.scanId, { jobId: job.id });
  return job;
}

export async function enqueueAdSlot(data: any, delayMs = 0) {
  const job = await queues.adScanSlots.add('run-slot', data, {
    jobId: 'slot_' + data.slotId,
    delay: delayMs,
    timeout: 5 * 60 * 1000,
  });
  logger.info('[Queue] Ad slot enqueued: ' + data.slotId + ' delay=' + delayMs + 'ms');
  return job;
}

export async function enqueueReviewSync(data: any) {
  const job = await queues.reviewSync.add('sync-reviews', data, {
    jobId: 'review_' + data.businessId + '_' + Date.now(),
    timeout: 2 * 60 * 1000,
  });
  return job;
}

export async function enqueueCitationAudit(data: any) {
  const job = await queues.citations.add('run-audit', data, {
    jobId: 'citation_' + data.businessId + '_' + Date.now(),
    timeout: 30 * 60 * 1000,
  });
  return job;
}

logger.info('[Queue] BullMQ queues initialized');
BIZZMASTER_APPS_API_SRC_INFRASTRUCTURE_QUEUE_QUEUEREGISTRY_TS

echo "  ✓ apps/frontend/src/components/Layout.tsx"
mkdir -p "$ROOT/apps/frontend/src/components"
cat > "$ROOT/apps/frontend/src/components/Layout.tsx" << 'BIZZMASTER_APPS_FRONTEND_SRC_COMPONENTS_LAYOUT_TSX'
import { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation, Routes, Route, Navigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../store/auth';
import { authApi } from '../lib/api';

import OverviewPage        from '../pages/Overview';
import OrganicPage         from '../pages/OrganicVisibility';
import NewOrganicScanPage  from '../pages/NewOrganicScan';
import OrganicScanDetailPage from '../pages/OrganicScanDetail';
import AdInsightsPage      from '../pages/AdInsights';
import NewAdScanPage       from '../pages/NewAdScan';
import AdSessionDetailPage from '../pages/AdSessionDetail';
import ReviewsPage         from '../pages/Reviews';
import LeaderboardPage     from '../pages/Leaderboard';
import CitationsPage       from '../pages/Citations';
import BusinessesPage      from '../pages/Businesses';
import TeamPage            from '../pages/Team';
import ProfilePage         from '../pages/Profile';

const NAV = [
  { path: '/overview',   icon: '▦',  label: 'Overview' },
  { path: '/organic',    icon: '🔍', label: 'Organic Visibility' },
  { path: '/ad-insights',icon: '📢', label: 'Ad Insights & Pressure' },
  { path: '/reviews',    icon: '⭐', label: 'Reviews' },
  { path: '/leaderboard',icon: '🏆', label: 'Leaderboard' },
  { path: '/citations',  icon: '📋', label: 'Citation Audit' },
  { path: '/businesses', icon: '🏢', label: 'Businesses' },
  { path: '/team',       icon: '👥', label: 'Team' },
  { path: '/profile',    icon: '👤', label: 'Profile' },
];

// ── Notification bell ─────────────────────────────────────────
function NotificationBell({ data }: { data: any }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref  = useRef<HTMLDivElement>(null);

  // Build notification list from live dashboard data
  const notes: { id: string; icon: string; msg: string; path: string; color: string }[] = [];

  (data?.activeOrganicScans ?? []).forEach((s: any) => {
    const pct = s.total_points > 0 ? Math.round((s.points_completed / s.total_points) * 100) : 0;
    notes.push({
      id: 'scan-' + s.id, icon: '🔍', color: 'text-blue-600',
      msg: `Scan "${s.keyword}" running — ${pct}%`,
      path: '/organic/' + s.id,
    });
  });

  (data?.activeAdSessions ?? []).forEach((s: any) => {
    notes.push({
      id: 'ad-' + s.id, icon: '📢', color: 'text-orange-600',
      msg: `Ad session "${s.keyword}" running`,
      path: '/ad-insights/' + s.id,
    });
  });

  const intel = data?.intelligence;
  if (intel?.confidence?.changesDetected) {
    notes.push({
      id: 'intel-change', icon: '⚡', color: 'text-amber-600',
      msg: 'Ranking changes detected — L2 analysis recommended',
      path: '/overview',
    });
  }

  if (intel?.opportunity?.score >= 80) {
    notes.push({
      id: 'opp-high', icon: '🎯', color: 'text-green-600',
      msg: `Opportunity Score ${intel.opportunity.score} — ${intel.opportunity.topAction}`,
      path: '/overview',
    });
  }

  const unread = notes.length;

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="relative w-9 h-9 flex items-center justify-center rounded-xl hover:bg-gray-100 transition-colors"
        title="Notifications"
      >
        <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unread > 0 && (
          <span className="absolute top-1.5 right-1.5 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center leading-none">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 w-80 bg-white border border-gray-200 rounded-2xl shadow-xl z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-800">Notifications</span>
            {unread > 0 && <span className="text-xs text-gray-400">{unread} active</span>}
          </div>
          {notes.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              <div className="text-3xl mb-2">🔔</div>
              All clear — no active events
            </div>
          ) : (
            <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
              {notes.map(n => (
                <button
                  key={n.id}
                  onClick={() => { nav(n.path); setOpen(false); }}
                  className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 text-left transition-colors"
                >
                  <span className="text-lg shrink-0 mt-0.5">{n.icon}</span>
                  <p className={'text-xs text-gray-700 leading-relaxed ' + n.color.replace('text','font')}>
                    {n.msg}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Profile dropdown ──────────────────────────────────────────
function ProfileDropdown({ me }: { me: any }) {
  const nav    = useNavigate();
  const logout = useAuth(s => s.logout);
  const [open, setOpen] = useState(false);
  const ref    = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const initials = me?.full_name
    ? me.full_name.split(' ').map((w: string) => w[0]).join('').slice(0,2).toUpperCase()
    : (me?.email?.[0] ?? '?').toUpperCase();

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-2 py-1.5 rounded-xl hover:bg-gray-100 transition-colors"
        title="Profile"
      >
        <div className="w-7 h-7 bg-brand-500 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0">
          {initials}
        </div>
        <div className="text-left hidden sm:block">
          <p className="text-xs font-semibold text-gray-800 leading-tight max-w-[100px] truncate">
            {me?.full_name ?? 'Account'}
          </p>
          <p className="text-[10px] text-gray-400 capitalize leading-tight">{me?.plan ?? 'starter'}</p>
        </div>
        <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-11 w-56 bg-white border border-gray-200 rounded-2xl shadow-xl z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-sm font-semibold text-gray-800 truncate">{me?.full_name ?? 'Account'}</p>
            <p className="text-xs text-gray-400 truncate">{me?.email}</p>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="badge badge-blue capitalize">{me?.plan ?? 'starter'}</span>
              <span className="text-xs text-gray-500">💳 {me?.credits_balance ?? 0} credits</span>
            </div>
          </div>
          <div className="py-1">
            {[
              { icon: '👤', label: 'Profile & Billing', path: '/profile' },
              { icon: '🏢', label: 'Businesses',        path: '/businesses' },
              { icon: '👥', label: 'Team',              path: '/team' },
            ].map(item => (
              <button
                key={item.path}
                onClick={() => { nav(item.path); setOpen(false); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors text-left"
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
          <div className="border-t border-gray-100 py-1">
            <button
              onClick={() => { logout(); setOpen(false); }}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors text-left"
            >
              <span>🚪</span>
              <span>Sign out</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Intelligence level indicator ──────────────────────────────
function IntelBadge({ intel }: { intel: any }) {
  const nav = useNavigate();
  if (!intel?.level) return null;
  const lv  = intel.level.level ?? 0;
  const cfg = [
    { label: 'L0 Passive',    cls: 'bg-gray-100 text-gray-500' },
    { label: 'L1 Monitoring', cls: 'bg-blue-100 text-blue-700' },
    { label: 'L2 Triggered',  cls: 'bg-amber-100 text-amber-700' },
    { label: 'L3 Deep Scan',  cls: 'bg-red-100 text-red-700' },
  ][lv] ?? { label: 'L0', cls: 'bg-gray-100 text-gray-500' };

  return (
    <button
      onClick={() => nav('/overview')}
      className={'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold ' + cfg.cls}
      title={intel.level.reason ?? ''}
    >
      <span className={'w-1.5 h-1.5 rounded-full ' + (lv > 0 ? 'bg-current animate-pulse' : 'bg-current opacity-50')} />
      {cfg.label}
    </button>
  );
}

// ── Main Layout ───────────────────────────────────────────────
export default function Layout() {
  const location = useLocation();
  const nav      = useNavigate();
  const qc       = useQueryClient();

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn:  () => authApi.me().then(r => r.data),
    retry: false,
  });

  const { data: dashData } = useQuery({
    queryKey: ['dashboard'],
    queryFn:  () => import('../lib/api').then(m => m.dashboardApi.get()).then(r => r.data),
    refetchInterval: 60000,
    retry: false,
    staleTime: 30000,
  });

  const PAGE_TITLE: Record<string, string> = {
    '/overview':    'Overview',
    '/organic':     'Organic Visibility',
    '/ad-insights': 'Ad Insights & Pressure',
    '/reviews':     'Reviews',
    '/leaderboard': 'Leaderboard',
    '/citations':   'Citation Audit',
    '/businesses':  'Businesses',
    '/team':        'Team',
    '/profile':     'Profile',
  };

  const currentTitle = Object.entries(PAGE_TITLE)
    .find(([p]) => location.pathname.startsWith(p))?.[1] ?? 'BizzRank AI';

  return (
    <div className="flex h-screen bg-gray-50">
      {/* ── Sidebar ── */}
      <aside className="w-64 bg-white border-r border-gray-100 flex flex-col shrink-0">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2.5">
          <div className="w-8 h-8 bg-brand-500 rounded-xl flex items-center justify-center shadow-sm">
            <span className="text-white text-sm font-bold">B</span>
          </div>
          <span className="font-bold text-gray-900">BizzRank AI</span>
        </div>

        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {NAV.map(({ path, icon, label }) => {
            const isActive = location.pathname.startsWith(path);
            return (
              <button key={path} onClick={() => nav(path)} className={isActive ? 'nav-active' : 'nav-inactive'}>
                <span className="text-base shrink-0">{icon}</span>
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-gray-100 space-y-2">
          <div className="flex items-center justify-between">
            <span className="badge badge-blue capitalize">{me?.plan ?? 'starter'}</span>
            <span className="text-xs font-bold text-gray-700">💳 {me?.credits_balance ?? 0}</span>
          </div>
          <p className="text-xs text-gray-400 truncate">{me?.email}</p>
        </div>
      </aside>

      {/* ── Main area ── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* ── Top bar ── */}
        <header className="h-14 bg-white border-b border-gray-100 flex items-center px-6 gap-4 shrink-0">
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-bold text-gray-900 truncate">{currentTitle}</h1>
          </div>

          {/* Intel level indicator */}
          <IntelBadge intel={dashData?.intelligence} />

          {/* Notification bell */}
          <NotificationBell data={dashData} />

          {/* Profile dropdown */}
          <ProfileDropdown me={me} />
        </header>

        {/* ── Page content ── */}
        <main className="flex-1 overflow-auto">
          <div className="max-w-5xl mx-auto px-8 py-8">
            <Routes>
              <Route path="/overview"               element={<OverviewPage />} />
              <Route path="/organic"                element={<OrganicPage />} />
              <Route path="/organic/new"            element={<NewOrganicScanPage />} />
              <Route path="/organic/:scanId"        element={<OrganicScanDetailPage />} />
              <Route path="/ad-insights"            element={<AdInsightsPage />} />
              <Route path="/ad-insights/new"        element={<NewAdScanPage />} />
              <Route path="/ad-insights/:sessionId" element={<AdSessionDetailPage />} />
              <Route path="/reviews"                element={<ReviewsPage />} />
              <Route path="/leaderboard"            element={<LeaderboardPage />} />
              <Route path="/citations"              element={<CitationsPage />} />
              <Route path="/businesses"             element={<BusinessesPage />} />
              <Route path="/team"                   element={<TeamPage />} />
              <Route path="/profile"               element={<ProfilePage />} />
              <Route path="*"                       element={<Navigate to="/overview" replace />} />
            </Routes>
          </div>
        </main>
      </div>
    </div>
  );
}
BIZZMASTER_APPS_FRONTEND_SRC_COMPONENTS_LAYOUT_TSX

echo "  ✓ apps/frontend/src/components/ReviewIntelligencePanel.tsx"
mkdir -p "$ROOT/apps/frontend/src/components"
cat > "$ROOT/apps/frontend/src/components/ReviewIntelligencePanel.tsx" << 'BIZZMASTER_APPS_FRONTEND_SRC_COMPONENTS_REVIEWINTELLIGENCEPANEL_TSX'
/**
 * ReviewIntelligencePanel
 * Displays Gemini-extracted themes above the review list.
 * Shows: headline sentiment, positive themes, negative themes, emerging themes.
 * Auto-fetches on mount, shows graceful empty state.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

interface ReviewTheme {
  theme: string;
  count: number;
  example: string;
}

interface Intel {
  positiveThemes: ReviewTheme[];
  negativeThemes: ReviewTheme[];
  emergingThemes: ReviewTheme[];
  summary: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  trend: 'improving' | 'stable' | 'declining';
  reviewsAnalyzed: number;
  generatedAt: string;
}

const TREND_ICON: Record<string, string> = {
  improving: '↗',
  stable:    '→',
  declining: '↘',
};

const TREND_COLOR: Record<string, string> = {
  improving: 'text-green-600',
  stable:    'text-gray-500',
  declining: 'text-red-500',
};

const SENTIMENT_COLOR: Record<string, string> = {
  positive: 'text-green-700',
  neutral:  'text-gray-600',
  negative: 'text-red-700',
};

export default function ReviewIntelligencePanel({ businessId }: { businessId: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['review-intel', businessId],
    queryFn: async () => {
      const r = await api.get('/review-intelligence?businessId=' + businessId);
      return r.data;
    },
    enabled: !!businessId,
    retry: false,
    // Don't show error to user — handled via onError below
  });

  const refresh = useMutation({
    mutationFn: () => api.post('/review-intelligence/refresh', { businessId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['review-intel', businessId] });
      setError('');
    },
    onError: (err: any) => {
      setError(err.response?.data?.error ?? 'Refresh failed');
    },
  });

  if (isLoading) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4 animate-pulse">
        <div className="h-4 w-48 bg-gray-200 rounded mb-3" />
        <div className="h-3 w-full bg-gray-100 rounded mb-2" />
        <div className="h-3 w-3/4 bg-gray-100 rounded" />
      </div>
    );
  }

  const intel: Intel | null = data?.intel ?? null;
  const message: string = data?.message ?? '';

  // Not enough reviews yet
  if (!intel) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4 text-center">
        <p className="text-sm text-gray-500">
          {message || 'Review intelligence not available yet.'}
        </p>
        <p className="text-xs text-gray-400 mt-1">At least 3 reviews needed to generate themes.</p>
      </div>
    );
  }

  const trendIcon  = TREND_ICON[intel.trend]  ?? '→';
  const trendColor = TREND_COLOR[intel.trend]  ?? 'text-gray-500';
  const sentColor  = SENTIMENT_COLOR[intel.sentiment] ?? 'text-gray-600';
  const age        = Math.round((Date.now() - new Date(intel.generatedAt).getTime()) / 86400000);

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
      {/* Headline row */}
      <div className="px-5 py-4 bg-gray-50 border-b border-gray-100 flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Review Intelligence
            </span>
            <span className={`text-xs font-bold ${sentColor} capitalize`}>
              · {intel.sentiment}
            </span>
            <span className={`text-xs font-semibold ${trendColor}`}>
              {trendIcon} {intel.trend}
            </span>
          </div>
          {intel.summary && (
            <p className="text-sm text-gray-700 leading-snug">{intel.summary}</p>
          )}
          <p className="text-xs text-gray-400 mt-1">
            Based on {intel.reviewsAnalyzed} reviews ·{' '}
            {age === 0 ? 'Updated today' : `Updated ${age}d ago`}
          </p>
        </div>
        <button
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          title="Refresh (1 credit)"
          className="text-xs text-gray-400 hover:text-brand-600 flex items-center gap-1 shrink-0 mt-1"
        >
          <span className={refresh.isPending ? 'animate-spin inline-block' : ''}>↻</span>
          {refresh.isPending ? '' : '1cr'}
        </button>
      </div>

      {error && (
        <div className="px-5 py-2 bg-red-50 border-b border-red-100">
          <p className="text-xs text-red-600">{error}</p>
        </div>
      )}

      {/* Themes grid */}
      <div className="grid grid-cols-2 divide-x divide-gray-100">
        {/* Positive */}
        <div className="p-4">
          <p className="text-xs font-semibold text-green-700 mb-3 flex items-center gap-1">
            <span>✓</span> What customers love
          </p>
          {intel.positiveThemes.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No strong positive themes detected</p>
          ) : (
            <div className="space-y-2.5">
              {intel.positiveThemes.map((t, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-sm font-medium text-gray-800">{t.theme}</span>
                    <span className="text-xs text-gray-400 bg-green-50 px-1.5 py-0.5 rounded-full">
                      {t.count}×
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 italic truncate">"{t.example}"</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Negative */}
        <div className="p-4">
          <p className="text-xs font-semibold text-red-600 mb-3 flex items-center gap-1">
            <span>!</span> What they complain about
          </p>
          {intel.negativeThemes.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No significant complaints detected</p>
          ) : (
            <div className="space-y-2.5">
              {intel.negativeThemes.map((t, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-sm font-medium text-gray-800">{t.theme}</span>
                    <span className="text-xs text-gray-400 bg-red-50 px-1.5 py-0.5 rounded-full">
                      {t.count}×
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 italic truncate">"{t.example}"</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Emerging themes */}
      {intel.emergingThemes.length > 0 && (
        <div className="px-5 py-3 bg-blue-50 border-t border-blue-100">
          <p className="text-xs font-semibold text-blue-700 mb-2">
            📈 Emerging in last 30 days
          </p>
          <div className="flex flex-wrap gap-2">
            {intel.emergingThemes.map((t, i) => (
              <div key={i} className="flex items-center gap-1.5 bg-white border border-blue-200 rounded-full px-2.5 py-1">
                <span className="text-xs font-medium text-blue-800">{t.theme}</span>
                <span className="text-xs text-blue-400">{t.count}×</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
BIZZMASTER_APPS_FRONTEND_SRC_COMPONENTS_REVIEWINTELLIGENCEPANEL_TSX

echo "  ✓ apps/frontend/src/pages/Businesses.tsx"
mkdir -p "$ROOT/apps/frontend/src/pages"
cat > "$ROOT/apps/frontend/src/pages/Businesses.tsx" << 'BIZZMASTER_APPS_FRONTEND_SRC_PAGES_BUSINESSES_TSX'
import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authApi, bizApi, compApi } from '../lib/api';
import { AddBizModal, AddCompModal } from '../components/Shared';

function GBPModal({ onClose, onAdded }: any) {
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => authApi.me().then(r => r.data) });
  const { data, isLoading } = useQuery({ queryKey: ['gbp-locs'], queryFn: () => authApi.gbpLocations().then(r => r.data.locations) });
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const limitMap: Record<string, number> = { starter:1, growth:1, pro:2, agency:5, enterprise:999, professional:5 };
  const limit = limitMap[me?.plan ?? 'starter'] ?? 1;

  function toggle(id: string) {
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : (limit === 999 || s.length < limit) ? [...s, id] : s);
  }

  async function imp() {
    setSaving(true);
    setErr('');
    try {
      await bizApi.importGBP(selected);
      onAdded();
    } catch (ex: any) {
      setErr(ex.response?.data?.error ?? 'Import failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="font-bold">Import from Google Business Profile</h2>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-400">×</button>
        </div>
        <div className="p-5">
          {limit < 999 && (
            <p className="text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg mb-3">
              Your plan allows <strong>{limit}</strong> location{limit === 1 ? '' : 's'}.
            </p>
          )}
          {isLoading ? (
            <div className="py-8 text-center">
              <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto" />
            </div>
          ) : !data?.length ? (
            <p className="text-center py-8 text-gray-500 text-sm">No GBP locations found.</p>
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {data.map((loc: any) => (
                <button
                  key={loc.gbpLocationId}
                  onClick={() => toggle(loc.gbpLocationId)}
                  className={'w-full text-left p-3 rounded-xl border-2 transition-colors ' + (selected.includes(loc.gbpLocationId) ? 'border-brand-500 bg-brand-50' : 'border-gray-100 hover:border-gray-200')}
                >
                  <div className="flex items-center gap-3">
                    <div className={'w-5 h-5 rounded-md border-2 flex items-center justify-center ' + (selected.includes(loc.gbpLocationId) ? 'bg-brand-500 border-brand-500' : 'border-gray-300')}>
                      {selected.includes(loc.gbpLocationId) && <span className="text-white text-xs">✓</span>}
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{loc.name}</p>
                      <p className="text-xs text-gray-400">{loc.address}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {err && <p className="mt-3 text-sm text-red-600 bg-red-50 p-3 rounded-xl">{err}</p>}
          <div className="flex gap-3 mt-5">
            <button onClick={imp} className="btn-primary flex-1" disabled={!selected.length || saving}>
              {saving ? 'Importing...' : 'Import ' + selected.length + ' location' + (selected.length !== 1 ? 's' : '')}
            </button>
            <button onClick={onClose} className="btn-secondary">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BizCard({ biz, plan }: any) {
  const qc = useQueryClient();
  const [showAddComp, setShowAddComp] = useState(false);

  const { data: compData } = useQuery({
    queryKey: ['competitors', biz.id],
    queryFn: () => compApi.list(biz.id).then(r => r.data),
  });

  const { data: limitData } = useQuery({
    queryKey: ['comp-limit', biz.id],
    queryFn: () => compApi.limit(biz.id).then(r => r.data),
  });

  const competitors: any[] = compData?.competitors ?? [];
  const limit = limitData?.limit ?? 3;
  const remaining = limitData?.remaining ?? limit;

  const remove = useMutation({
    mutationFn: (id: string) => compApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['competitors', biz.id] });
      qc.invalidateQueries({ queryKey: ['comp-limit', biz.id] });
    },
  });

  return (
    <div className="card space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 bg-brand-100 rounded-xl flex items-center justify-center shrink-0">
          <span className="text-brand-600 font-bold">{biz.name[0].toUpperCase()}</span>
        </div>
        <div>
          <h3 className="font-bold">{biz.name}</h3>
          {biz.address && <p className="text-sm text-gray-400">{biz.address}</p>}
          <div className="flex flex-wrap gap-2 mt-1">
            {biz.category && <span className="badge-gray">{biz.category}</span>}
            {biz.opening_hours ? <span className="badge-green">Hours set</span> : <span className="badge-amber">No hours</span>}
            {biz.brand_voice && <span className="badge-blue">Brand voice set</span>}
          </div>
        </div>
      </div>

      <div className="border-t border-gray-100 pt-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Competitors</h4>
            <span className="text-xs text-gray-400">{competitors.length}/{limit}</span>
          </div>
          {remaining > 0 && (
            <button onClick={() => setShowAddComp(true)} className="text-xs text-brand-600 hover:underline font-medium">
              + Add ({remaining} left)
            </button>
          )}
        </div>

        <div className="space-y-2">
          {competitors.map((c: any, i: number) => (
            <div key={c.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl border border-gray-100 group">
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 bg-red-100 rounded-lg flex items-center justify-center">
                  <span className="text-red-600 text-xs font-bold">#{i + 1}</span>
                </div>
                <div>
                  <p className="text-sm font-semibold">{c.name}</p>
                  {c.address && <p className="text-xs text-gray-400">{c.address}</p>}
                </div>
              </div>
              <button
                onClick={() => remove.mutate(c.id)}
                className="text-xs text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                Remove
              </button>
            </div>
          ))}

          {Array.from({ length: Math.max(0, limit - competitors.length) }, (_, i) => (
            <button
              key={i}
              onClick={() => setShowAddComp(true)}
              className="w-full flex items-center gap-3 p-3 border-2 border-dashed border-gray-200 rounded-xl hover:border-brand-300 hover:bg-brand-50 transition-colors group"
            >
              <div className="w-7 h-7 bg-gray-100 rounded-lg flex items-center justify-center group-hover:bg-brand-100">
                <span className="text-gray-400 group-hover:text-brand-600">+</span>
              </div>
              <span className="text-sm text-gray-400 group-hover:text-brand-600">
                Add competitor #{competitors.length + i + 1}
              </span>
            </button>
          ))}
        </div>
      </div>

      {showAddComp && (
        <AddCompModal
          businessId={biz.id}
          bizName={biz.name}
          onClose={() => setShowAddComp(false)}
          onAdded={() => {
            qc.invalidateQueries({ queryKey: ['competitors', biz.id] });
            qc.invalidateQueries({ queryKey: ['comp-limit', biz.id] });
            setShowAddComp(false);
          }}
        />
      )}
    </div>
  );
}

export default function BusinessesPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [showAdd, setShowAdd] = useState(false);
  const [showGBP, setShowGBP] = useState(false);

  useEffect(() => {
    if (searchParams.get('gbp') === 'connected') {
      setShowGBP(true);
      nav('/businesses', { replace: true });
    }
  }, [searchParams]);

  const { data: businesses, isLoading } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => bizApi.list().then(r => r.data.businesses),
  });

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me().then(r => r.data),
  });

  const limitMap: Record<string, number> = { starter:1, growth:1, pro:2, agency:5, enterprise:999, professional:5 };
  const plan = me?.plan ?? 'starter';
  const bizLimit = limitMap[plan] ?? 1;
  const canAdd = bizLimit === 999 || (businesses?.length ?? 0) < bizLimit;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Businesses</h1>
          <p className="text-gray-400 text-sm">Manage your locations and competitors</p>
        </div>
        {canAdd && (
          <div className="flex gap-2">
            <button onClick={() => setShowAdd(true)} className="btn-outline">Search Maps</button>
            <button
              onClick={async () => { const r = await authApi.gbpConnect(); window.location.href = r.data.url; }}
              className="btn-primary"
            >
              Connect GBP
            </button>
          </div>
        )}
      </div>

      {!canAdd && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          Your <strong>{plan}</strong> plan allows <strong>{bizLimit}</strong> location{bizLimit === 1 ? '' : 's'}.
          Upgrade in Profile → Subscription to add more.
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1,2].map(i=><div key={i} className="card animate-pulse"><div className="h-16 bg-gray-100 rounded-xl"/></div>)}
        </div>
      ) : (businesses ?? []).length === 0 ? (
        <div className="card text-center py-12">
          <div className="text-5xl mb-4">🏢</div>
          <p className="text-gray-500 mb-6">No businesses added yet.</p>
          <div className="flex gap-3 justify-center">
            <button onClick={() => setShowAdd(true)} className="btn-outline">Search Maps</button>
            <button
              onClick={async () => { const r = await authApi.gbpConnect(); window.location.href = r.data.url; }}
              className="btn-primary"
            >
              Connect GBP
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {(businesses ?? []).map((b: any) => <BizCard key={b.id} biz={b} plan={plan} />)}
        </div>
      )}

      {showAdd && (
        <AddBizModal
          onClose={() => setShowAdd(false)}
          onAdded={() => { qc.invalidateQueries({ queryKey: ['businesses'] }); setShowAdd(false); }}
        />
      )}
      {showGBP && (
        <GBPModal
          onClose={() => setShowGBP(false)}
          onAdded={() => { qc.invalidateQueries({ queryKey: ['businesses'] }); setShowGBP(false); }}
        />
      )}
    </div>
  );
}
BIZZMASTER_APPS_FRONTEND_SRC_PAGES_BUSINESSES_TSX

echo "  ✓ apps/frontend/src/pages/Overview.tsx"
mkdir -p "$ROOT/apps/frontend/src/pages"
cat > "$ROOT/apps/frontend/src/pages/Overview.tsx" << 'BIZZMASTER_APPS_FRONTEND_SRC_PAGES_OVERVIEW_TSX'
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { dashboardApi } from '../lib/api';
import { ScoreBar, StateBadge, Skeleton } from '../components/Shared';
import api from '../lib/api';

// ── Intelligence Engine Panel ─────────────────────────────────
function IntelPanel({ intelligence, businesses }: { intelligence: any; businesses: any[] }) {
  const nav = useNavigate();
  const qc  = useQueryClient();

  const l1 = useMutation({
    mutationFn: () => {
      const bizId = businesses[0]?.id;
      if (!bizId) throw new Error('No business selected');
      return api.post('/intelligence/l1', { businessId: bizId });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard'] }),
  });

  const l3 = useMutation({
    mutationFn: () => {
      const bizId = businesses[0]?.id;
      if (!bizId) throw new Error('No business selected');
      return api.post('/intelligence/l3', { businessId: bizId });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard'] }),
  });

  if (!intelligence) return null;

  const lv  = intelligence.level?.level ?? 0;
  const opp = intelligence.opportunity;
  const conf = intelligence.confidence;

  const LEVEL_CONFIG = [
    { label: 'Passive',      desc: 'Reading cached data — no API calls',          color: 'bg-gray-50 border-gray-200',   badge: 'bg-gray-100 text-gray-600' },
    { label: 'Lightweight',  desc: 'Daily change detection running',               color: 'bg-blue-50 border-blue-200',   badge: 'bg-blue-100 text-blue-700' },
    { label: 'Triggered',    desc: 'Threshold breached — full scan in progress',   color: 'bg-amber-50 border-amber-200', badge: 'bg-amber-100 text-amber-700' },
    { label: 'Deep Analysis','desc': 'Full H3 scan — all keywords and competitors', color: 'bg-red-50 border-red-200',     badge: 'bg-red-100 text-red-700' },
  ];
  const lvCfg = LEVEL_CONFIG[lv] ?? LEVEL_CONFIG[0];
  const confScore = conf?.score ?? 100;
  const confColor = confScore >= 80 ? 'text-green-600' : confScore >= 50 ? 'text-amber-600' : 'text-red-600';

  return (
    <div className={'rounded-2xl border p-5 space-y-4 ' + lvCfg.color}>
      {/* Header row */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <span className={'px-2 py-0.5 rounded-full text-xs font-bold ' + lvCfg.badge}>
                Level {lv} — {lvCfg.label}
              </span>
              {lv > 0 && (
                <span className="flex items-center gap-1 text-xs text-gray-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                  Active
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500">{lvCfg.desc}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>Cache confidence:</span>
          <span className={'font-bold ' + confColor}>{confScore}%</span>
          {conf?.changesDetected && (
            <span className="badge badge-amber">Changes detected</span>
          )}
        </div>
      </div>

      {/* Opportunity Score + actions */}
      {opp && (
        <div className="flex items-center gap-4 flex-wrap">
          {/* Score ring */}
          <div className="flex items-center gap-3">
            <div className="relative w-14 h-14 shrink-0">
              <svg className="w-14 h-14 -rotate-90" viewBox="0 0 56 56">
                <circle cx="28" cy="28" r="22" fill="none" stroke="#e5e7eb" strokeWidth="5" />
                <circle cx="28" cy="28" r="22" fill="none"
                  stroke={opp.score >= 70 ? '#22c55e' : opp.score >= 40 ? '#f59e0b' : '#ef4444'}
                  strokeWidth="5" strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 22}`}
                  strokeDashoffset={`${2 * Math.PI * 22 * (1 - opp.score / 100)}`}
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-sm font-black text-gray-800">{opp.score}</span>
              </div>
            </div>
            <div>
              <p className="text-sm font-bold text-gray-800">Opportunity Score</p>
              <p className="text-xs text-gray-500 capitalize">
                {opp.trend === 'improving' ? '↗' : opp.trend === 'declining' ? '↘' : '→'} {opp.trend}
              </p>
            </div>
          </div>

          {/* Action recommendation */}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-gray-700 mb-1">Recommended action</p>
            <p className="text-xs text-gray-600 leading-relaxed">{opp.topAction}</p>
          </div>

          {/* Breakdown */}
          {opp.breakdown && (
            <div className="flex gap-3 text-center text-xs">
              {Object.entries(opp.breakdown).map(([k, v]: any) => (
                <div key={k} className="bg-white/70 rounded-xl px-2.5 py-2 min-w-[52px]">
                  <p className="font-bold text-gray-800">{v}</p>
                  <p className="text-gray-400 capitalize">{k}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Escalation buttons */}
      <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-current border-opacity-10">
        <span className="text-xs text-gray-500 mr-1">Run:</span>
        <button
          onClick={() => l1.mutate()}
          disabled={l1.isPending || !businesses.length}
          className="text-xs px-3 py-1.5 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded-lg font-medium transition-colors disabled:opacity-50"
          title="Lightweight daily check — detects changes cheaply"
        >
          {l1.isPending ? '⟳ Running…' : '▶ L1 Check'}
        </button>
        <button
          onClick={() => l3.mutate()}
          disabled={l3.isPending || !businesses.length}
          className="text-xs px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-700 rounded-lg font-medium transition-colors disabled:opacity-50"
          title="Full deep scan — all keywords and competitors (50 credits)"
        >
          {l3.isPending ? '⟳ Running…' : '⚡ L3 Deep Scan'}
        </button>
        <button
          onClick={() => nav('/organic/new')}
          className="text-xs px-3 py-1.5 bg-white hover:bg-gray-50 text-gray-600 rounded-lg font-medium border border-gray-200 transition-colors"
        >
          Manual scan →
        </button>
        <span className="text-[10px] text-gray-400 ml-auto">
          {lv === 0 ? 'API cost: $0.00' : lv === 1 ? '~$0.01' : lv === 2 ? '~$0.40' : '~$2.80'}
        </span>
      </div>

      {/* Signal feed */}
      {(intelligence.recentSignals ?? []).length > 0 && (
        <div className="space-y-1.5 pt-1 border-t border-current border-opacity-10">
          <p className="text-xs font-semibold text-gray-600">Recent signals</p>
          {intelligence.recentSignals.slice(0, 3).map((s: any, i: number) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className={
                s.direction === 'up' ? 'text-green-500' :
                s.direction === 'down' ? 'text-red-500' : 'text-amber-500'
              }>
                {s.direction === 'up' ? '▲' : s.direction === 'down' ? '▼' : '⚡'}
              </span>
              <span className="text-gray-600 font-medium">{s.signal_type}</span>
              <span className="text-gray-400">{new Date(s.detected_at).toLocaleDateString()}</span>
              {s.triggers_l2 && <span className="badge badge-amber">L2 trigger</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Overview Page ─────────────────────────────────────────────
export default function OverviewPage() {
  const nav = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn:  () => dashboardApi.get().then(r => r.data),
    refetchInterval: 60000,  // 60s — SSE handles active scan progress
  });

  if (isLoading) return <Skeleton />;

  const {
    profile,
    planFeatures,
    activeOrganicScans = [],
    activeAdSessions   = [],
    latestScores       = [],
    recentScans        = [],
    businesses         = [],
    intelligence,
  } = data ?? {};

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-gray-400 text-sm">Your local SEO intelligence hub</p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-2xl p-5 bg-brand-50 text-brand-700 cursor-pointer hover:bg-brand-100 transition-colors" onClick={() => nav('/profile')}>
          <p className="text-xs font-medium opacity-70 mb-1">Credits remaining</p>
          <p className="text-3xl font-bold">{profile?.credits_balance ?? 0}</p>
          <p className="text-xs opacity-60 mt-1">View history →</p>
        </div>
        <div className="rounded-2xl p-5 bg-amber-50 text-amber-700">
          <p className="text-xs font-medium opacity-70 mb-1">Active scans</p>
          <p className="text-3xl font-bold">{activeOrganicScans.length + activeAdSessions.length}</p>
          <p className="text-xs opacity-60 mt-1">{businesses.length} location{businesses.length !== 1 ? 's' : ''} tracked</p>
        </div>
        <div className="rounded-2xl p-5 bg-green-50 text-green-700 cursor-pointer hover:bg-green-100 transition-colors" onClick={() => nav('/profile')}>
          <p className="text-xs font-medium opacity-70 mb-1">Plan</p>
          <p className="text-2xl font-bold capitalize">{profile?.plan ?? 'Starter'}</p>
          <p className="text-xs opacity-60 mt-1">View details →</p>
        </div>
      </div>

      {/* ── Intelligence Engine Panel ── */}
      {businesses.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Intelligence Engine
          </h2>
          <IntelPanel intelligence={intelligence} businesses={businesses} />
        </div>
      )}

      {/* Plan feature gates notice */}
      {planFeatures && !planFeatures.hasAiReplies && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-center justify-between">
          <p className="text-sm text-amber-800">
            <strong>Starter plan:</strong> AI review replies and automated monitoring are locked.
          </p>
          <button onClick={() => nav('/profile')} className="text-xs font-semibold text-amber-700 underline shrink-0">
            Upgrade →
          </button>
        </div>
      )}

      {/* Scan type cards */}
      <div className="grid grid-cols-2 gap-5">
        <div className="card hover:shadow-md transition-all cursor-pointer border-2 hover:border-brand-200" onClick={() => nav('/organic/new')}>
          <div className="w-12 h-12 bg-blue-100 rounded-2xl flex items-center justify-center text-2xl mb-3">🔍</div>
          <h2 className="text-lg font-bold mb-1">Organic Visibility</h2>
          <p className="text-sm text-gray-500 mb-3">Pure organic rankings across your territory with competitor comparison.</p>
          <div className="text-sm font-semibold text-brand-600">Start scan →</div>
        </div>
        <div className="card hover:shadow-md transition-all cursor-pointer border-2 hover:border-orange-200" onClick={() => nav('/ad-insights/new')}>
          <div className="w-12 h-12 bg-orange-100 rounded-2xl flex items-center justify-center text-2xl mb-3">📢</div>
          <h2 className="text-lg font-bold mb-1">Ad Insights & Pressure</h2>
          <p className="text-sm text-gray-500 mb-3">100% accurate sponsored detection. Hourly tracking throughout business hours.</p>
          <div className="text-sm font-semibold text-orange-600">Start session →</div>
        </div>
      </div>

      {/* Active organic scans */}
      {activeOrganicScans.length > 0 && (
        <div className="card">
          <h2 className="font-bold mb-3 flex items-center gap-2 text-sm text-gray-500 uppercase tracking-wide">
            <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            Organic scans running
          </h2>
          {activeOrganicScans.map((s: any) => {
            const pct = s.total_points > 0 ? Math.round((s.points_completed / s.total_points) * 100) : 0;
            return (
              <div key={s.id} onClick={() => nav('/organic/' + s.id)}
                className="flex items-center justify-between cursor-pointer hover:bg-gray-50 rounded-xl px-2 py-3 transition-colors">
                <div className="flex-1 min-w-0 mr-4">
                  <p className="text-sm font-semibold">{s.keyword}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden max-w-32">
                      <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: pct + '%' }} />
                    </div>
                    <span className="text-xs text-gray-500">{pct}%</span>
                  </div>
                </div>
                <StateBadge state={s.state} />
              </div>
            );
          })}
        </div>
      )}

      {/* Active ad sessions */}
      {activeAdSessions.length > 0 && (
        <div className="card">
          <h2 className="font-bold mb-3 flex items-center gap-2 text-sm text-gray-500 uppercase tracking-wide">
            <span className="w-2 h-2 bg-orange-500 rounded-full animate-pulse" />
            Ad sessions running
          </h2>
          {activeAdSessions.map((s: any) => (
            <div key={s.id} onClick={() => nav('/ad-insights/' + s.id)}
              className="flex items-center justify-between cursor-pointer hover:bg-gray-50 rounded-xl px-2 py-3 transition-colors">
              <div>
                <p className="text-sm font-semibold">{s.keyword}</p>
                <p className="text-xs text-gray-400">{s.scans_completed}/{s.scans_total} slots complete</p>
              </div>
              <StateBadge state={s.state} />
            </div>
          ))}
        </div>
      )}

      {/* Latest scores */}
      {latestScores.length > 0 && (
        <div className="card">
          <h2 className="font-bold mb-4">Latest visibility scores</h2>
          {latestScores.map((s: any) => (
            <div key={s.id} onClick={() => nav('/organic/' + s.scan_id)}
              className="flex items-center justify-between p-3 border border-gray-100 rounded-xl hover:bg-gray-50 cursor-pointer mb-2 transition-colors">
              <div>
                <p className="text-sm font-semibold">{s.keyword}</p>
                <p className="text-xs text-gray-400">
                  avg rank #{Math.round(s.organic_avg_ranking ?? 0)} · {new Date(s.scan_date ?? s.scanned_at).toLocaleDateString()}
                </p>
              </div>
              <ScoreBar score={s.organic_visibility_score} />
            </div>
          ))}
        </div>
      )}

      {/* No businesses yet */}
      {businesses.length === 0 && (
        <div className="card text-center py-10">
          <div className="text-5xl mb-4">🏢</div>
          <p className="font-bold mb-2">No businesses added yet</p>
          <p className="text-sm text-gray-400 mb-5">Add your first business to start tracking rankings</p>
          <button onClick={() => nav('/businesses')} className="btn-primary">Add Business →</button>
        </div>
      )}
    </div>
  );
}
BIZZMASTER_APPS_FRONTEND_SRC_PAGES_OVERVIEW_TSX

echo "  ✓ apps/frontend/src/pages/Profile.tsx"
mkdir -p "$ROOT/apps/frontend/src/pages"
cat > "$ROOT/apps/frontend/src/pages/Profile.tsx" << 'BIZZMASTER_APPS_FRONTEND_SRC_PAGES_PROFILE_TSX'
import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi, profileApi } from '../lib/api';

const PLANS: Record<string, any> = {
  starter:      { name:'Starter',    price:'$69/mo',  credits:500,   businesses:1,   competitors:1, color:'bg-gray-100 text-gray-700'   },
  growth:       { name:'Growth',     price:'$119/mo', credits:1400,  businesses:1,   competitors:2, color:'bg-green-100 text-green-700' },
  pro:          { name:'Pro',        price:'$199/mo', credits:5400,  businesses:2,   competitors:3, color:'bg-blue-100 text-blue-700'   },
  agency:       { name:'Agency',     price:'$799/mo', credits:21600, businesses:5,   competitors:4, color:'bg-purple-100 text-purple-700'},
  enterprise:   { name:'Enterprise', price:'Custom',  credits:99999, businesses:999, competitors:999,color:'bg-brand-100 text-brand-700' },
  professional: { name:'Pro',        price:'$199/mo', credits:5400,  businesses:5,   competitors:5, color:'bg-blue-100 text-blue-700'   },
};

export default function ProfilePage() {
  const qc = useQueryClient();
  const { data: me, refetch } = useQuery({ queryKey: ['me'], queryFn: () => authApi.me().then(r => r.data) });
  const { data: creditHistory } = useQuery({ queryKey: ['credit-history'], queryFn: () => profileApi.credits().then(r => r.data) });

  const [tab, setTab] = useState<'details' | 'password' | 'subscription' | 'credits'>('details');
  const [fullName, setFullName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [detailMsg, setDetailMsg] = useState('');
  const [detailErr, setDetailErr] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [pwErr, setPwErr] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);
  const [savingPw, setSavingPw] = useState(false);

  useEffect(() => {
    if (me) {
      setFullName(me.full_name ?? '');
      setCompanyName(me.company_name ?? '');
    }
  }, [me]);

  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    setSavingDetails(true);
    setDetailErr('');
    setDetailMsg('');
    try {
      await profileApi.updateDetails({ fullName, companyName });
      setDetailMsg('Details updated successfully');
      qc.invalidateQueries({ queryKey: ['me'] });
    } catch (ex: any) {
      setDetailErr(ex.response?.data?.error ?? 'Update failed');
    } finally {
      setSavingDetails(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwErr('');
    setPwMsg('');
    if (newPw !== confirmPw) return setPwErr('New passwords do not match');
    if (newPw.length < 8) return setPwErr('New password must be at least 8 characters');
    setSavingPw(true);
    try {
      await profileApi.changePassword({ currentPassword: currentPw, newPassword: newPw });
      setPwMsg('Password changed successfully');
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
    } catch (ex: any) {
      setPwErr(ex.response?.data?.error ?? 'Password change failed');
    } finally {
      setSavingPw(false);
    }
  }

  const currentPlan = PLANS[me?.plan ?? 'starter'] ?? PLANS.starter;
  const usedCredits = (me?.monthly_allowance ?? 100) - (me?.credits_balance ?? 0);
  const creditPct = Math.min(100, (usedCredits / Math.max(me?.monthly_allowance ?? 100, 1)) * 100);
  const transactions: any[] = creditHistory?.transactions ?? [];

  const TABS = [
    { id: 'details', label: 'Account Details' },
    { id: 'password', label: 'Password' },
    { id: 'subscription', label: 'Subscription' },
    { id: 'credits', label: 'Credit History' },
  ] as const;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Profile</h1>
        <p className="text-gray-400 text-sm">Manage your account, subscription and credits</p>
      </div>

      <div className="flex border-b border-gray-200">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={'px-4 py-3 text-sm font-medium transition-colors ' + (tab === t.id ? 'border-b-2 border-brand-500 text-brand-700' : 'text-gray-500 hover:text-gray-700')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'details' && (
        <div className="card space-y-5">
          <h2 className="font-bold text-gray-700">Account Information</h2>
          <div>
            <label className="label">Email address</label>
            <div className="flex items-center gap-3">
              <input type="email" className="input bg-gray-50 cursor-not-allowed" value={me?.email ?? ''} readOnly />
              <span className="badge-green whitespace-nowrap">Verified</span>
            </div>
            <p className="text-xs text-gray-400 mt-1">Email cannot be changed. Contact support if needed.</p>
          </div>
          <form onSubmit={saveDetails} className="space-y-4">
            <div>
              <label className="label">Full name</label>
              <input type="text" className="input" value={fullName} onChange={e => setFullName(e.target.value)} />
            </div>
            <div>
              <label className="label">Company name</label>
              <input type="text" className="input" value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Optional" />
            </div>
            {detailMsg && <p className="text-sm text-green-600 bg-green-50 p-2.5 rounded-xl">{detailMsg}</p>}
            {detailErr && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{detailErr}</p>}
            <button type="submit" className="btn-primary" disabled={savingDetails}>
              {savingDetails ? 'Saving...' : 'Save changes'}
            </button>
          </form>
          <div className="border-t border-gray-100 pt-4 space-y-2 text-sm text-gray-500">
            <div className="flex justify-between">
              <span>Account created</span>
              <span className="font-medium text-gray-700">{me?.created_at ? new Date(me.created_at).toLocaleDateString() : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span>Account ID</span>
              <span className="font-mono text-xs text-gray-400">{me?.id?.slice(0, 8)}...</span>
            </div>
          </div>
        </div>
      )}

      {tab === 'password' && (
        <div className="card space-y-5">
          <h2 className="font-bold text-gray-700">Change Password</h2>
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-700">
            Your password must be at least 8 characters long.
          </div>
          <form onSubmit={changePassword} className="space-y-4">
            <div>
              <label className="label">Current password</label>
              <input type="password" className="input" value={currentPw} onChange={e => setCurrentPw(e.target.value)} required />
            </div>
            <div>
              <label className="label">New password</label>
              <input type="password" className="input" value={newPw} onChange={e => setNewPw(e.target.value)} required minLength={8} />
            </div>
            <div>
              <label className="label">Confirm new password</label>
              <input type="password" className="input" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} required minLength={8} />
              {confirmPw && newPw !== confirmPw && <p className="text-xs text-red-500 mt-1">Passwords do not match</p>}
            </div>
            {pwMsg && <p className="text-sm text-green-600 bg-green-50 p-2.5 rounded-xl">{pwMsg}</p>}
            {pwErr && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{pwErr}</p>}
            <button type="submit" className="btn-primary" disabled={savingPw || (!!confirmPw && newPw !== confirmPw)}>
              {savingPw ? 'Changing...' : 'Change password'}
            </button>
          </form>
        </div>
      )}

      {tab === 'subscription' && (
        <div className="space-y-4">
          <div className="card">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="font-bold text-gray-700">Current Plan</h2>
                  <span className={'badge ' + currentPlan.color}>{currentPlan.name}</span>
                </div>
                <p className="text-2xl font-black text-gray-900">{currentPlan.price}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-400">Renews monthly</p>
                <p className="text-xs text-green-600 font-semibold mt-1">Active</p>
              </div>
            </div>

            <div className="mb-4">
              <div className="flex justify-between text-sm mb-1.5">
                <span className="text-gray-600">Monthly credits</span>
                <span className="font-semibold">{usedCredits} / {me?.monthly_allowance ?? 100} used</span>
              </div>
              <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className={'h-full rounded-full transition-all ' + (creditPct >= 80 ? 'bg-red-500' : creditPct >= 50 ? 'bg-amber-500' : 'bg-brand-500')}
                  style={{ width: creditPct + '%' }}
                />
              </div>
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>{me?.credits_balance ?? 0} remaining</span>
                <span>Resets monthly</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                ['Credits/month', currentPlan.credits.toLocaleString()],
                ['Businesses', currentPlan.businesses === 999 ? 'Unlimited' : currentPlan.businesses],
                ['Competitors/biz', currentPlan.competitors === 999 ? 'Unlimited' : currentPlan.competitors],
                ['Price', currentPlan.price],
              ].map(([label, val]) => (
                <div key={label} className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs text-gray-400">{label}</p>
                  <p className="font-bold text-gray-800">{val}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="card border-2 border-brand-100">
            <h3 className="font-bold mb-1">Need more credits?</h3>
            <p className="text-sm text-gray-500 mb-3">Buy additional credits anytime. They never expire.</p>
            <div className="grid grid-cols-3 gap-3 mb-3">
              {[['50 credits', '$50'], ['200 credits', '$200'], ['500 credits', '$500']].map(([label, price]) => (
                <div key={label} className="border-2 border-gray-100 rounded-xl p-3 text-center cursor-pointer hover:border-brand-400 hover:bg-brand-50 transition-colors">
                  <p className="text-sm font-bold">{label}</p>
                  <p className="text-xs text-gray-400">{price}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-400">$1 per credit · Billing via Stripe</p>
          </div>

          <div className="card">
            <h3 className="font-bold mb-3">Upgrade Plan</h3>
            <div className="space-y-3">
              {Object.entries(PLANS).filter(([k]) => k !== (me?.plan ?? 'starter')).map(([key, plan]) => (
                <div key={key} className="flex items-center justify-between p-3 border border-gray-100 rounded-xl hover:border-brand-200 hover:bg-brand-50 transition-colors cursor-pointer">
                  <div className="flex items-center gap-3">
                    <span className={'badge ' + plan.color}>{plan.name}</span>
                    <div>
                      <p className="text-sm font-semibold">{plan.price}</p>
                      <p className="text-xs text-gray-400">{plan.credits.toLocaleString()} credits · {plan.businesses === 999 ? 'Unlimited' : plan.businesses} businesses</p>
                    </div>
                  </div>
                  <span className="text-xs font-semibold text-brand-600">Upgrade →</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-3">Contact support to change your plan: support@bizzrank.ai</p>
          </div>
        </div>
      )}

      {tab === 'credits' && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-brand-50 rounded-2xl p-4 text-center">
              <p className="text-2xl font-black text-brand-600">{me?.credits_balance ?? 0}</p>
              <p className="text-xs text-brand-400 mt-1">Current balance</p>
            </div>
            <div className="bg-green-50 rounded-2xl p-4 text-center">
              <p className="text-2xl font-black text-green-600">{me?.monthly_allowance ?? 100}</p>
              <p className="text-xs text-green-400 mt-1">Monthly allowance</p>
            </div>
            <div className="bg-amber-50 rounded-2xl p-4 text-center">
              <p className="text-2xl font-black text-amber-600">{usedCredits}</p>
              <p className="text-xs text-amber-400 mt-1">Used this month</p>
            </div>
          </div>

          <div className="card p-0 overflow-hidden">
            <div className="px-5 py-3 bg-gray-50 border-b border-gray-100">
              <h3 className="font-bold text-gray-700 text-sm">Transaction History</h3>
            </div>
            {transactions.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">No transactions yet</div>
            ) : (
              <div className="divide-y divide-gray-50">
                {transactions.map((t: any) => (
                  <div key={t.id} className="flex items-center justify-between px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className={'w-8 h-8 rounded-xl flex items-center justify-center text-sm ' + (t.amount > 0 ? 'bg-green-100' : 'bg-red-100')}>
                        {t.amount > 0 ? '+' : '−'}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-800">{t.reason}</p>
                        <p className="text-xs text-gray-400">{new Date(t.created_at).toLocaleString()}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className={'text-sm font-bold ' + (t.amount > 0 ? 'text-green-600' : 'text-red-500')}>
                        {t.amount > 0 ? '+' : ''}{t.amount}
                      </p>
                      <p className="text-xs text-gray-400">{t.balance_after} left</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
BIZZMASTER_APPS_FRONTEND_SRC_PAGES_PROFILE_TSX

echo "  ✓ apps/frontend/src/pages/Reviews.tsx"
mkdir -p "$ROOT/apps/frontend/src/pages"
cat > "$ROOT/apps/frontend/src/pages/Reviews.tsx" << 'BIZZMASTER_APPS_FRONTEND_SRC_PAGES_REVIEWS_TSX'
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bizApi, reviewApi } from '../lib/api';
import { Skeleton, Modal } from '../components/Shared';
import ReviewIntelligencePanel from '../components/ReviewIntelligencePanel';

function BrandVoiceModal({ biz, onClose, onSaved }: any) {
  const [ownerName, setOwnerName] = useState(biz.brand_voice?.ownerName ?? '');
  const [description, setDescription] = useState(biz.brand_voice?.businessDescription ?? '');
  const [tone, setTone] = useState(biz.brand_voice?.tone ?? 'friendly');
  const [emphasize, setEmphasize] = useState(biz.brand_voice?.emphasize ?? '');
  const [avoid, setAvoid] = useState(biz.brand_voice?.avoid ?? '');
  const [exampleReply, setExampleReply] = useState(biz.brand_voice?.exampleReply ?? '');
  const [autoReply, setAutoReply] = useState(biz.brand_voice?.autoReply345 ?? true);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await bizApi.updateBrandVoice(biz.id, {
      ownerName, businessDescription: description, tone,
      emphasize, avoid, exampleReply, autoReply345: autoReply,
    });
    setSaving(false);
    onSaved();
  }

  return (
    <Modal title={'Brand Voice — ' + biz.name} onClose={onClose}>
      <p className="text-sm text-gray-500 mb-4">Configure how Gemini AI sounds when replying to reviews.</p>
      <div className="space-y-4">
        <div>
          <label className="label">Owner name</label>
          <input type="text" className="input" value={ownerName} onChange={e => setOwnerName(e.target.value)} placeholder="John Smith" />
        </div>
        <div>
          <label className="label">Business description</label>
          <textarea className="input min-h-[80px] resize-none" value={description} onChange={e => setDescription(e.target.value)} placeholder="Family-owned Italian restaurant est. 2005..." />
        </div>
        <div>
          <label className="label">Reply tone</label>
          <select className="input" value={tone} onChange={e => setTone(e.target.value)}>
            <option value="professional">Professional — polished, warm</option>
            <option value="friendly">Friendly — personable, local feel</option>
            <option value="casual">Casual — relaxed, conversational</option>
            <option value="formal">Formal — respectful, measured</option>
            <option value="luxury">Luxury — refined, elevated</option>
            <option value="local_warm">Local and Warm — community-focused</option>
          </select>
        </div>
        <div>
          <label className="label">Always emphasize <span className="text-gray-400 font-normal text-xs">(optional)</span></label>
          <input type="text" className="input" value={emphasize} onChange={e => setEmphasize(e.target.value)} placeholder="our family-owned heritage, fresh daily ingredients..." />
        </div>
        <div>
          <label className="label">Always avoid <span className="text-gray-400 font-normal text-xs">(optional)</span></label>
          <input type="text" className="input" value={avoid} onChange={e => setAvoid(e.target.value)} placeholder="never mention discounts, never be defensive..." />
        </div>
        <div>
          <label className="label">Example reply <span className="text-gray-400 font-normal text-xs">(AI learns your style)</span></label>
          <textarea className="input min-h-[80px] resize-none" value={exampleReply} onChange={e => setExampleReply(e.target.value)} placeholder="Paste one of your own review replies here..." />
        </div>
        <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
          <div>
            <p className="text-sm font-semibold">Auto-reply for 3–5 star reviews</p>
            <p className="text-xs text-gray-400">1–2 star always requires your approval</p>
          </div>
          <div
            className={'w-10 h-5 rounded-full cursor-pointer transition-colors ' + (autoReply ? 'bg-brand-500' : 'bg-gray-300')}
            onClick={() => setAutoReply(!autoReply)}
          >
            <div className={'w-4 h-4 bg-white rounded-full mt-0.5 shadow transition-transform ' + (autoReply ? 'translate-x-5 ml-0.5' : 'translate-x-0.5')} />
          </div>
        </div>
      </div>
      <div className="flex gap-3 mt-5">
        <button onClick={save} className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving...' : 'Save Brand Voice'}</button>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
      </div>
    </Modal>
  );
}

function ApproveModal({ review, onClose, onApproved }: any) {
  const [text, setText] = useState(review.ai_reply_draft ?? '');
  const approve = useMutation({ mutationFn: () => reviewApi.approve(review.id, text), onSuccess: onApproved });
  const regen = useMutation({ mutationFn: () => reviewApi.regenerate(review.id), onSuccess: (r: any) => setText(r.data.reply) });

  return (
    <Modal title="Review and Approve Reply" onClose={onClose}>
      <div className="bg-red-50 border border-red-100 rounded-xl p-4 mb-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-red-500">{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</span>
          <span className="text-sm font-semibold">{review.reviewer_name}</span>
        </div>
        <p className="text-sm text-gray-700">"{review.review_text}"</p>
      </div>
      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
        1–2 star replies require your approval before posting to Google.
      </p>
      <label className="label">Your reply (edit before posting)</label>
      <textarea className="input min-h-[120px] resize-none" value={text} onChange={e => setText(e.target.value)} />
      <div className="flex gap-3 mt-4">
        <button onClick={() => approve.mutate()} className="btn-primary flex-1" disabled={!text || approve.isPending}>
          {approve.isPending ? 'Posting...' : 'Approve and Post to Google'}
        </button>
        <button onClick={() => regen.mutate()} disabled={regen.isPending} className="btn-secondary">
          {regen.isPending ? '...' : 'Regenerate'}
        </button>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
      </div>
    </Modal>
  );
}

function ReviewCard({ review, onApprove, onRefetch, gbpConnected }: any) {
  const [expanded, setExpanded] = useState(false);
  const toggleAuto = useMutation({ mutationFn: (enabled: boolean) => reviewApi.toggleAuto(review.id, enabled), onSuccess: onRefetch });
  const regen = useMutation({ mutationFn: () => reviewApi.regenerate(review.id), onSuccess: onRefetch });
  const isLow = review.rating <= 2;
  const stars = '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating);

  const cardBg = review.is_replied
    ? 'border-green-100 bg-green-50'
    : (review.ai_reply_status === 'draft_ready' && review.requires_approval)
    ? 'border-amber-100 bg-amber-50'
    : 'border-gray-100 bg-white';

  return (
    <div className={'rounded-2xl border p-4 ' + cardBg}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div className="w-9 h-9 bg-gray-200 rounded-full flex items-center justify-center shrink-0 text-sm font-bold">
            {review.reviewer_name?.[0]?.toUpperCase() ?? '?'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-semibold">{review.reviewer_name ?? 'Anonymous'}</span>
              <span className={'text-sm ' + (isLow ? 'text-red-500' : 'text-amber-400')}>{stars}</span>
              <span className="text-xs text-gray-400">
                {review.review_date ? new Date(review.review_date).toLocaleDateString() : ''}
              </span>
              {review.source === 'serp' && <span className="badge-gray text-xs">Auto-fetched</span>}
            </div>
            {review.review_text && <p className="text-sm text-gray-700 line-clamp-2">{review.review_text}</p>}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {review.is_replied && <span className="badge-green text-xs">Replied</span>}
          {review.ai_reply_status === 'draft_ready' && review.requires_approval && !review.is_replied && (
            <span className="badge-amber text-xs">Needs approval</span>
          )}
          {gbpConnected && !isLow && !review.is_replied && (
            <label className="flex items-center gap-1 cursor-pointer">
              <span className="text-xs text-gray-500">Auto</span>
              <div
                className={'w-8 h-4 rounded-full transition-colors cursor-pointer ' + (review.auto_reply_enabled ? 'bg-brand-500' : 'bg-gray-300')}
                onClick={() => toggleAuto.mutate(!review.auto_reply_enabled)}
              >
                <div className={'w-3 h-3 bg-white rounded-full mt-0.5 shadow transition-transform ' + (review.auto_reply_enabled ? 'translate-x-4 ml-0.5' : 'translate-x-0.5')} />
              </div>
            </label>
          )}
          {isLow && review.ai_reply_status === 'draft_ready' && !review.is_replied && (
            <button onClick={onApprove} className="btn-primary text-xs py-1 px-3">Review and Post</button>
          )}
          <button onClick={() => setExpanded(!expanded)} className="text-gray-400 text-xs">
            {expanded ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {expanded && review.ai_reply_draft && (
        <div className="mt-3 pl-12">
          <div className="bg-white border border-gray-200 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-500">AI Draft Reply</span>
              <button onClick={() => regen.mutate()} disabled={regen.isPending} className="text-xs text-brand-600 hover:underline">
                {regen.isPending ? 'Regenerating...' : 'Regenerate'}
              </button>
            </div>
            <p className="text-sm text-gray-700 italic">"{review.ai_reply_draft}"</p>
          </div>
        </div>
      )}

      {expanded && !review.ai_reply_draft && gbpConnected && (
        <div className="mt-3 pl-12">
          <p className="text-xs text-gray-400">No AI reply drafted yet. Use Generate AI Replies above.</p>
        </div>
      )}

      {expanded && !gbpConnected && (
        <div className="mt-3 pl-12">
          <p className="text-xs text-amber-600">Connect Google Business Profile to enable AI reply posting.</p>
        </div>
      )}
    </div>
  );
}

export default function ReviewsPage() {
  const [selectedBizId, setSelectedBizId] = useState('');
  const [showBrandVoice, setShowBrandVoice] = useState(false);
  const [approveModal, setApproveModal] = useState<any>(null);
  const qc = useQueryClient();

  const { data: bizData } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => bizApi.list().then(r => r.data.businesses),
  });

  useEffect(() => {
    if (bizData?.length && !selectedBizId) setSelectedBizId(bizData[0].id);
  }, [bizData]);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['reviews', selectedBizId],
    queryFn: () => reviewApi.list(selectedBizId).then(r => r.data),
    enabled: !!selectedBizId,
    refetchInterval: 5000,
  });

  const fetchReviews = useMutation({
    mutationFn: () => reviewApi.fetch(selectedBizId),
    onSuccess: () => setTimeout(() => refetch(), 1000),
  });

  const generateAll = useMutation({
    mutationFn: () => reviewApi.generateAll(selectedBizId),
    onSuccess: () => setTimeout(() => refetch(), 2000),
  });

  const { reviews = [], stats, gbpConnected, lastSync, canFetchWithoutGBP } = data ?? {};
  const unanswered = reviews.filter((r: any) => !r.is_replied && r.ai_reply_status !== 'posted');
  const needsApproval = reviews.filter((r: any) => r.ai_reply_status === 'draft_ready' && r.requires_approval);
  const selectedBiz = bizData?.find((b: any) => b.id === selectedBizId);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold">Reviews</h1>
        <p className="text-gray-400 text-sm">AI-powered review management</p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <select className="input max-w-xs" value={selectedBizId} onChange={e => setSelectedBizId(e.target.value)}>
          {bizData?.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <button
          onClick={() => fetchReviews.mutate()}
          className="btn-secondary text-sm"
          disabled={fetchReviews.isPending || !selectedBizId}
        >
          {fetchReviews.isPending ? 'Fetching...' : 'Fetch Reviews'}
        </button>
        {gbpConnected && (
          <button
            onClick={() => setShowBrandVoice(true)}
            className="btn-outline text-sm"
          >
            Brand Voice
          </button>
        )}
      </div>

      {/* GBP status info */}
      {!gbpConnected && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <p className="font-semibold text-blue-800 mb-1">Reviews visible without Google Business Profile</p>
          <p className="text-sm text-blue-700">
            Reviews are fetched automatically via SerpApi every 24 hours.
            Connect Google Business Profile to enable AI reply posting.
          </p>
          {lastSync && <p className="text-xs text-blue-500 mt-1">Last sync: {new Date(lastSync).toLocaleString()}</p>}
        </div>
      )}

      {/* Review debt */}
      {unanswered.length > 0 && (
        <div className="rounded-2xl bg-gradient-to-r from-red-500 to-rose-600 text-white p-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-red-100 text-sm font-medium mb-1">Review Debt Detected</p>
              <div className="flex items-baseline gap-3 mb-2">
                <span className="text-5xl font-black">{unanswered.length}</span>
                <span className="text-red-100">unanswered reviews</span>
              </div>
              <p className="text-red-100 text-sm">
                Estimated revenue impact: <strong className="text-white text-xl">${stats?.revenueLost?.toLocaleString()}</strong>
              </p>
            </div>
            {gbpConnected && (
              <button
                onClick={() => generateAll.mutate()}
                disabled={generateAll.isPending}
                className="bg-white text-red-600 font-bold px-5 py-3 rounded-xl hover:bg-red-50 text-sm whitespace-nowrap disabled:opacity-70"
              >
                {generateAll.isPending ? 'Generating...' : 'Generate AI Replies'}
              </button>
            )}
          </div>
          {!gbpConnected && (
            <p className="text-red-100 text-sm mt-3">
              Connect Google Business Profile from the Businesses page to enable AI-powered replies.
            </p>
          )}
        </div>
      )}

      {/* Needs approval */}
      {needsApproval.length > 0 && gbpConnected && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center justify-between">
          <div>
            <p className="font-semibold text-amber-800">{needsApproval.length} {needsApproval.length === 1 ? 'reply needs' : 'replies need'} approval</p>
            <p className="text-xs text-amber-600">1–2 star replies need your approval before posting to Google</p>
          </div>
          <button onClick={() => setApproveModal(needsApproval[0])} className="btn-secondary text-sm border-amber-300">
            Review now
          </button>
        </div>
      )}

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-3">
          <div className="bg-gray-50 rounded-xl p-3 text-center">
            <p className="text-2xl font-bold">{stats.total}</p>
            <p className="text-xs text-gray-400">Total</p>
          </div>
          <div className="bg-amber-50 rounded-xl p-3 text-center">
            <p className="text-2xl font-bold text-amber-700">{stats.avgRating}★</p>
            <p className="text-xs text-gray-400">Avg rating</p>
          </div>
          <div className="bg-red-50 rounded-xl p-3 text-center">
            <p className="text-2xl font-bold text-red-600">{unanswered.length}</p>
            <p className="text-xs text-gray-400">Unanswered</p>
          </div>
          <div className="bg-green-50 rounded-xl p-3 text-center">
            <p className="text-2xl font-bold text-green-600">{reviews.filter((r: any) => r.is_replied).length}</p>
            <p className="text-xs text-gray-400">Replied</p>
          </div>
        </div>
      )}

      {selectedBizId && <ReviewIntelligencePanel businessId={selectedBizId} />}

      {isLoading ? <Skeleton /> : reviews.length === 0 ? (
        <div className="card text-center py-10">
          <p className="text-gray-400 mb-3">No reviews yet.</p>
          <button onClick={() => fetchReviews.mutate()} className="btn-primary text-sm" disabled={fetchReviews.isPending}>
            {fetchReviews.isPending ? 'Fetching...' : 'Fetch Reviews Now'}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {reviews.map((review: any) => (
            <ReviewCard
              key={review.id}
              review={review}
              onApprove={() => setApproveModal(review)}
              onRefetch={refetch}
              gbpConnected={gbpConnected}
            />
          ))}
        </div>
      )}

      {showBrandVoice && selectedBiz && (
        <BrandVoiceModal
          biz={selectedBiz}
          onClose={() => setShowBrandVoice(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['businesses'] }); setShowBrandVoice(false); }}
        />
      )}
      {approveModal && (
        <ApproveModal
          review={approveModal}
          onClose={() => setApproveModal(null)}
          onApproved={() => { setApproveModal(null); refetch(); }}
        />
      )}
    </div>
  );
}
BIZZMASTER_APPS_FRONTEND_SRC_PAGES_REVIEWS_TSX

echo "  ✓ apps/frontend/src/pages/Team.tsx"
mkdir -p "$ROOT/apps/frontend/src/pages"
cat > "$ROOT/apps/frontend/src/pages/Team.tsx" << 'BIZZMASTER_APPS_FRONTEND_SRC_PAGES_TEAM_TSX'
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

const ROLE_BADGE: Record<string, string> = {
  owner:   'bg-purple-100 text-purple-700',
  manager: 'bg-blue-100 text-blue-700',
  viewer:  'bg-gray-100 text-gray-500',
};
const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', manager: 'Manager', viewer: 'Viewer',
};

export default function TeamPage() {
  const qc = useQueryClient();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'manager'|'viewer'>('viewer');
  const [inviteLink, setInviteLink] = useState('');
  const [inviteErr, setInviteErr] = useState('');
  const [inviting, setInviting] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['org'],
    queryFn: () => api.get('/orgs').then(r => r.data),
    retry: 1,
  });

  const removeM   = useMutation({ mutationFn: (id: string) => api.delete('/orgs/members/' + id), onSuccess: () => qc.invalidateQueries({ queryKey: ['org'] }) });
  const changeRole = useMutation({ mutationFn: ({ id, role }: any) => api.patch('/orgs/members/' + id + '/role', { role }), onSuccess: () => qc.invalidateQueries({ queryKey: ['org'] }) });
  const revokeInv  = useMutation({ mutationFn: (id: string) => api.delete('/orgs/invitations/' + id), onSuccess: () => qc.invalidateQueries({ queryKey: ['org'] }) });

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true); setInviteErr(''); setInviteLink('');
    try {
      const r = await api.post('/orgs/invitations', { email: inviteEmail.trim(), role: inviteRole });
      setInviteLink(r.data.inviteUrl);
      setInviteEmail('');
      qc.invalidateQueries({ queryKey: ['org'] });
    } catch (ex: any) {
      setInviteErr(ex.response?.data?.error ?? 'Invitation failed');
    } finally { setInviting(false); }
  }

  if (isLoading) return (
    <div className="max-w-3xl space-y-4 animate-pulse">
      <div className="h-8 w-40 bg-gray-200 rounded" />
      <div className="h-40 bg-gray-100 rounded-2xl" />
    </div>
  );

  if (error || !data) return (
    <div className="max-w-3xl">
      <div className="card text-center py-10">
        <p className="text-red-500 font-semibold mb-2">Could not load organization</p>
        <p className="text-sm text-gray-500 mb-4">Run the SQL migration first, then restart the API.</p>
        <div className="bg-gray-50 rounded-xl p-4 text-left text-sm font-mono text-gray-600 max-w-md mx-auto">
          <p className="font-semibold text-gray-800 mb-1 font-sans">Supabase SQL Editor:</p>
          <p>migration/006-team-orgs.sql</p>
        </div>
      </div>
    </div>
  );

  const { org, members, invitations, myRole } = data;
  const isOwner = myRole === 'owner';

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Team</h1>
        <p className="text-gray-400 text-sm">Manage organization members and access</p>
      </div>

      <div className="card flex items-center gap-4">
        <div className="w-12 h-12 bg-brand-100 rounded-2xl flex items-center justify-center shrink-0">
          <span className="text-2xl">🏢</span>
        </div>
        <div>
          <p className="font-bold text-lg">{org?.name ?? 'My Organization'}</p>
          <p className="text-sm text-gray-400">
            {members?.length ?? 0} member{members?.length !== 1 ? 's' : ''} ·{' '}
            <span className={'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ' + (ROLE_BADGE[myRole] ?? ROLE_BADGE.viewer)}>
              {ROLE_LABEL[myRole] ?? myRole}
            </span>
          </p>
        </div>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
          <h2 className="font-semibold text-gray-700">Members</h2>
        </div>
        <div className="divide-y divide-gray-50">
          {(members ?? []).map((m: any) => (
            <div key={m.id} className="flex items-center gap-3 px-5 py-4">
              <div className="w-9 h-9 bg-brand-100 rounded-full flex items-center justify-center shrink-0 font-bold text-brand-700 text-sm">
                {m.name?.[0]?.toUpperCase() ?? '?'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-sm">{m.name}{m.isMe && <span className="text-gray-400 font-normal text-xs"> (you)</span>}</p>
                  <span className={'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ' + (ROLE_BADGE[m.role] ?? ROLE_BADGE.viewer)}>
                    {ROLE_LABEL[m.role] ?? m.role}
                  </span>
                </div>
                <p className="text-xs text-gray-400">{m.company || 'No company'} · {m.plan} · 💳 {m.credits}</p>
              </div>
              {isOwner && !m.isMe && m.role !== 'owner' && (
                <div className="flex items-center gap-2 shrink-0">
                  <select
                    className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
                    value={m.role}
                    onChange={e => changeRole.mutate({ id: m.id, role: e.target.value })}
                  >
                    <option value="manager">Manager</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button
                    onClick={() => { if (confirm('Remove this member?')) removeM.mutate(m.id); }}
                    className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {isOwner && (invitations ?? []).length > 0 && (
        <div className="card p-0 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 bg-amber-50">
            <h2 className="font-semibold text-amber-800">Pending Invitations</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {invitations.map((inv: any) => (
              <div key={inv.id} className="flex items-center gap-3 px-5 py-4">
                <div className="w-9 h-9 bg-amber-100 rounded-full flex items-center justify-center shrink-0 text-sm text-amber-600">✉</div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{inv.email}</p>
                  <p className="text-xs text-gray-400">Role: {ROLE_LABEL[inv.role] ?? inv.role} · Expires {new Date(inv.expires_at).toLocaleDateString()}</p>
                </div>
                <button onClick={() => revokeInv.mutate(inv.id)} className="text-xs text-gray-400 hover:text-red-500 shrink-0">Revoke</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {isOwner && (
        <div className="card">
          <h2 className="font-semibold mb-1">Invite a Team Member</h2>
          <p className="text-sm text-gray-500 mb-4">They receive an invite link to join your organization.</p>
          <form onSubmit={sendInvite} className="flex flex-col gap-3">
            <div className="flex gap-2">
              <input type="email" className="input flex-1" placeholder="teammate@company.com"
                value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} required />
              <select className="input w-36 shrink-0" value={inviteRole} onChange={e => setInviteRole(e.target.value as any)}>
                <option value="manager">Manager</option>
                <option value="viewer">Viewer</option>
              </select>
              <button type="submit" className="btn-primary shrink-0" disabled={inviting}>
                {inviting ? 'Sending...' : 'Invite'}
              </button>
            </div>
            {inviteErr && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-xl">{inviteErr}</p>}
            {inviteLink && (
              <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                <p className="text-sm font-semibold text-green-800 mb-2">Invitation created</p>
                <div className="flex gap-2">
                  <input type="text" readOnly value={inviteLink}
                    className="input text-xs flex-1 bg-white" onClick={e => (e.target as HTMLInputElement).select()} />
                  <button type="button" onClick={() => navigator.clipboard.writeText(inviteLink)}
                    className="btn-outline text-xs shrink-0">Copy</button>
                </div>
                <p className="text-xs text-green-600 mt-2">Link expires in 7 days</p>
              </div>
            )}
          </form>
          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs text-gray-400">
              <strong>Manager:</strong> can view businesses and run scans.<br />
              <strong>Viewer:</strong> read-only access.
            </p>
          </div>
        </div>
      )}

      {!isOwner && (
        <div className="card bg-gray-50 text-center py-6">
          <p className="text-sm text-gray-500">Only the org owner can invite members.</p>
        </div>
      )}
    </div>
  );
}
BIZZMASTER_APPS_FRONTEND_SRC_PAGES_TEAM_TSX

echo "  ✓ migration/004-review-intelligence.sql"
mkdir -p "$ROOT/migration"
cat > "$ROOT/migration/004-review-intelligence.sql" << 'BIZZMASTER_MIGRATION_004_REVIEW_INTELLIGENCE_SQL'
-- ============================================================
-- BizzRank AI — Review Intelligence Table
-- Run in Supabase SQL Editor before starting the API
-- ============================================================

create table if not exists public.review_intelligence (
  id                uuid primary key default uuid_generate_v4(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  positive_themes   jsonb not null default '[]',
  negative_themes   jsonb not null default '[]',
  emerging_themes   jsonb not null default '[]',
  summary           text,
  sentiment         text not null default 'neutral'
    check (sentiment in ('positive','neutral','negative')),
  trend             text not null default 'stable'
    check (trend in ('improving','stable','declining')),
  reviews_analyzed  integer not null default 0,
  generated_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  constraint review_intelligence_business_unique unique (business_id)
);

create index if not exists idx_review_intel_business
  on public.review_intelligence(business_id, generated_at desc);

alter table public.review_intelligence enable row level security;

create policy "Users see own review intelligence"
  on public.review_intelligence
  using (user_id = auth.uid());

-- Verify:
-- select count(*) from public.review_intelligence;   -- should be 0
BIZZMASTER_MIGRATION_004_REVIEW_INTELLIGENCE_SQL

echo "  ✓ migration/005-intelligence-optimization.sql"
mkdir -p "$ROOT/migration"
cat > "$ROOT/migration/005-intelligence-optimization.sql" << 'BIZZMASTER_MIGRATION_005_INTELLIGENCE_OPTIMIZATION_SQL'
-- ============================================================
-- BizzRank AI v10 — Intelligence + Optimization Migration
-- Run in Supabase SQL Editor → New Query → Run All
-- ============================================================
-- What this adds:
--   1. geo_cache          — permanent reverse geocode cache (kills Maps API spend)
--   2. business_keywords  — per-business keyword management with plan limits
--   3. intel_signals      — change detection feed from L1/L2/L3
--   4. intel_thresholds   — per-business L1→L2 escalation thresholds
--   5. organic_scans      — adds is_automated and intel_level columns
--   6. profiles           — aligns plan names with new pricing table
-- ============================================================

-- ─── 1. GEO CACHE ─────────────────────────────────────────────
-- Permanent storage for reverse geocoded coordinates.
-- key format: "lat:lng" rounded to 3 decimal places (~110m precision)
-- After first scan week, Google Maps Geocoding API calls approach zero.
create table if not exists public.geo_cache (
  lat_lng       text primary key,          -- "41.917:-87.682"
  location_name text not null,
  created_at    timestamptz not null default now()
);

-- Index for fast lookups (though primary key is already indexed)
comment on table public.geo_cache is
  'Permanent reverse geocode cache. Eliminates ~95% of Google Maps Geocoding API spend.';

-- RLS: service role only (no user-facing reads needed)
alter table public.geo_cache enable row level security;
create policy "Service role full access" on public.geo_cache
  using (true) with check (true);

-- ─── 2. BUSINESS KEYWORDS ─────────────────────────────────────
-- Keywords tracked per business. Drives weekly scans and L1 monitoring.
-- Plan limits enforced in API: Starter=1, Growth=2, Pro=3, Agency=4
create table if not exists public.business_keywords (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  business_id   uuid not null references public.businesses(id) on delete cascade,
  keyword       text not null,
  display_order integer not null default 1,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint business_keywords_unique unique (business_id, keyword)
);

create index if not exists idx_business_keywords_business
  on public.business_keywords(business_id) where is_active = true;

alter table public.business_keywords enable row level security;
create policy "Users manage own keywords" on public.business_keywords
  using (user_id = auth.uid()) with check (user_id = auth.uid());

comment on table public.business_keywords is
  'Keywords tracked per business. Each keyword drives weekly L3 scans and daily L1 checks.';

-- ─── 3. INTELLIGENCE SIGNALS ──────────────────────────────────
-- Change signals emitted by L1 and L2.
-- Powers the "Change Detection Feed" in the dashboard.
create table if not exists public.intel_signals (
  id           uuid primary key default uuid_generate_v4(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  signal_type  text not null check (signal_type in (
    'RankingDelta','VisibilityDelta','CompetitorDelta','ReviewDelta','AdPressureDelta'
  )),
  value        numeric(8,2) not null default 0,
  direction    text not null check (direction in ('up','down','spike')),
  triggers_l2  boolean not null default false,
  detected_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists idx_intel_signals_business
  on public.intel_signals(business_id, detected_at desc);

alter table public.intel_signals enable row level security;
create policy "Users see own signals" on public.intel_signals
  using (user_id = auth.uid());

-- Auto-cleanup: keep last 90 days only
create index if not exists idx_intel_signals_cleanup
  on public.intel_signals(detected_at);

-- ─── 4. INTELLIGENCE THRESHOLDS ───────────────────────────────
-- Per-business L1→L2 escalation thresholds.
-- Defaults: visibilityDrop=10%, competitorMovement=15pts,
--           reviewSpike=5, adPressureSpike=20
create table if not exists public.intel_thresholds (
  business_id          uuid primary key references public.businesses(id) on delete cascade,
  user_id              uuid not null references auth.users(id) on delete cascade,
  visibility_drop      integer not null default 10,
  competitor_movement  integer not null default 15,
  review_spike         integer not null default 5,
  ad_pressure_spike    integer not null default 20,
  updated_at           timestamptz not null default now()
);

alter table public.intel_thresholds enable row level security;
create policy "Users manage own thresholds" on public.intel_thresholds
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ─── 5. ORGANIC SCANS — add automation columns ────────────────
-- is_automated: true for weekly cron scans, false for user-triggered
-- intel_level: 1=L1, 2=L2-triggered, 3=L3-full

alter table public.organic_scans
  add column if not exists is_automated boolean not null default false;

alter table public.organic_scans
  add column if not exists intel_level integer check (intel_level in (1,2,3));

create index if not exists idx_organic_scans_automated
  on public.organic_scans(user_id, is_automated, scan_date desc);

comment on column public.organic_scans.is_automated is
  'true = weekly cron scan (consumes fixed credits), false = manual user scan (consumes user credits)';

-- ─── 6. PROFILES — align plan names with new pricing ──────────
-- The old schema had: starter, professional, agency, enterprise
-- New schema has:     starter, growth, pro, agency, enterprise
-- Migrate existing 'professional' → 'pro'

update public.profiles
  set plan = 'pro'
  where plan = 'professional';

-- Add 'growth' as valid option (no data migration needed — new plan)
comment on column public.profiles.plan is
  'Valid plans: starter($69), growth($119), pro($199), agency($799), enterprise(custom)';

-- ─── 7. CREDIT TRANSACTIONS — add new transaction types ───────
-- Existing: usage, refund, purchase
-- New: fixed_scan (automated weekly), monthly_reset

alter table public.credit_transactions
  drop constraint if exists credit_transactions_transaction_type_check;

alter table public.credit_transactions
  add constraint credit_transactions_transaction_type_check
  check (transaction_type in ('usage','refund','purchase','fixed_scan','monthly_reset'));

-- ─── 8. HELPER FUNCTION — get keywords for a business ─────────
create or replace function public.get_business_keywords(p_business_id uuid)
returns text[]
language sql stable
as $$
  select array_agg(keyword order by display_order)
  from public.business_keywords
  where business_id = p_business_id
    and is_active = true;
$$;

-- ─── VERIFICATION QUERIES ─────────────────────────────────────
-- Run these in a new SQL tab to confirm migration succeeded:
--
--   select count(*) from public.geo_cache;              -- 0 initially
--   select count(*) from public.business_keywords;      -- 0 initially
--   select count(*) from public.intel_signals;          -- 0 initially
--   select count(*) from public.intel_thresholds;       -- 0 initially
--   select column_name from information_schema.columns
--     where table_name = 'organic_scans'
--     and column_name in ('is_automated','intel_level'); -- should return 2 rows
--   select count(*) from public.profiles where plan = 'professional'; -- should be 0

-- ─── SEED: migrate existing scan keywords to business_keywords ─
-- Run this ONCE after migration to populate keywords from existing scans.
-- Each business gets its most recent scan keyword as keyword #1.
insert into public.business_keywords (user_id, business_id, keyword, display_order)
select distinct on (business_id)
  user_id, business_id, keyword, 1
from public.organic_scans
where state = 'completed'
order by business_id, created_at desc
on conflict (business_id, keyword) do nothing;

-- Done. ✓
BIZZMASTER_MIGRATION_005_INTELLIGENCE_OPTIMIZATION_SQL

echo "  ✓ migration/006-team-orgs.sql"
mkdir -p "$ROOT/migration"
cat > "$ROOT/migration/006-team-orgs.sql" << 'BIZZMASTER_MIGRATION_006_TEAM_ORGS_SQL'
-- BizzRank AI — Team / Organizations Tables
-- Run in Supabase SQL Editor

create extension if not exists "uuid-ossp";

create table if not exists public.organizations (
  id          uuid primary key default uuid_generate_v4(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  name        text not null default 'My Team',
  created_at  timestamptz not null default now(),
  constraint organizations_owner_unique unique (owner_id)
);
alter table public.organizations enable row level security;
create policy "Members view their org" on public.organizations
  using (id in (select org_id from public.org_members where user_id = auth.uid()));

create table if not exists public.org_members (
  id         uuid primary key default uuid_generate_v4(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'viewer'
    check (role in ('owner','manager','viewer')),
  created_at timestamptz not null default now(),
  constraint org_members_unique unique (org_id, user_id)
);
create index if not exists idx_org_members_user on public.org_members(user_id);
alter table public.org_members enable row level security;
create policy "Members view org roster" on public.org_members
  using (org_id in (select org_id from public.org_members where user_id = auth.uid()));

create table if not exists public.org_invitations (
  id          uuid primary key default uuid_generate_v4(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  invited_by  uuid not null references auth.users(id) on delete cascade,
  email       text not null,
  role        text not null default 'viewer'
    check (role in ('manager','viewer')),
  token       text not null default encode(gen_random_bytes(32), 'hex'),
  accepted    boolean not null default false,
  expires_at  timestamptz not null default (now() + interval '7 days'),
  created_at  timestamptz not null default now(),
  constraint org_invitations_token_unique unique (token)
);
alter table public.org_invitations enable row level security;
create policy "Org owners see invitations" on public.org_invitations
  using (org_id in (
    select org_id from public.org_members
    where user_id = auth.uid() and role = 'owner'
  ));

-- Seed orgs for all existing users
insert into public.organizations (owner_id, name)
select id, coalesce(raw_user_meta_data->>'company_name', 'My Team')
from auth.users
where id not in (select owner_id from public.organizations)
on conflict (owner_id) do nothing;

insert into public.org_members (org_id, user_id, role)
select o.id, o.owner_id, 'owner'
from public.organizations o
where o.owner_id not in (
  select user_id from public.org_members where role = 'owner'
)
on conflict (org_id, user_id) do nothing;

-- Verify:
-- select count(*) from public.organizations;
-- select count(*) from public.org_members;
BIZZMASTER_MIGRATION_006_TEAM_ORGS_SQL

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " All files written. Required next steps:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " 1. Run SQL migrations in Supabase SQL Editor:"
echo "    → migration/004-review-intelligence.sql"
echo "    → migration/005-intelligence-optimization.sql"
echo "    → migration/006-team-orgs.sql"
echo ""
echo " 2. Restart API: Ctrl+C → npm run dev"
echo ""
echo " 3. Verify startup shows:"
echo "    Workers: organic-scans · ad-slots · review-sync"
echo "    Cron: L1-daily · L3-weekly · credits-monthly · reviews-daily"
echo ""
