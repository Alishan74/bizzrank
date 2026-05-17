import { Router, Request, Response } from 'express';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { enqueueOrganicScan } from '../../infrastructure/queue/QueueRegistry.js';
import { billingService } from '../../domains/billing/BillingService.js';
import { geoService } from '../../domains/geo/GeoService.js';
import { checkConcurrentScans } from '../../infrastructure/cache/CacheService.js';
import { redis } from '../../infrastructure/cache/RedisClient.js';
import { NoLocationError, NoScanPointsError, RateLimitError } from '../../shared/errors/DomainErrors.js';
import { logger } from '../../infrastructure/logger/Logger.js';

const router = Router();

router.get('/address-autocomplete', requireAuth, async (req: AuthRequest, res: Response) => {
  const q = req.query.q as string;
  if (!q || q.length < 2) return res.json({ suggestions: [] });
  const { getAddressAutocomplete } = await import('../../domains/identity/GoogleMapsService.js');
  res.json({ suggestions: await getAddressAutocomplete(q) });
});

router.get('/address-details/:placeId', requireAuth, async (req, res) => {
  const { getPlaceDetails } = await import('../../domains/identity/GoogleMapsService.js');
  const d = await getPlaceDetails(req.params.placeId);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json({ lat: d.latitude, lng: d.longitude, address: d.address });
});

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { data } = await db
    .from('organic_scans')
    .select('*, organic_scores(organic_visibility_score, organic_avg_ranking, organic_territory_dominance, organic_top3_cells, organic_total_cells)')
    .eq('user_id', req.userId!)
    .order('created_at', { ascending: false })
    .limit(50);
  res.json({ scans: data ?? [] });
});

router.get('/:scanId', requireAuth, async (req: AuthRequest, res: Response) => {
  const { data: scan } = await db.from('organic_scans').select('*').eq('id', req.params.scanId).eq('user_id', req.userId!).single();
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  const { data: score } = await db.from('organic_scores').select('*').eq('scan_id', req.params.scanId).single();
  const { data: rankings } = await db.from('organic_rankings').select('latitude, longitude, rank_position, point_index, point_label, location_name, found_business_name, found_place_id, result_type, google_maps_url').eq('scan_id', req.params.scanId).order('point_index').order('rank_position', { ascending: true, nullsFirst: false });
  res.json({ scan, score, rankings: rankings ?? [] });
});

// SSE endpoint — real-time scan progress
router.get('/:scanId/progress', requireAuth, async (req: AuthRequest, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const scanId = req.params.scanId;
  const subscriber = redis.duplicate();
  await subscriber.subscribe(`scan:progress:${scanId}`);

  subscriber.on('message', (channel, message) => {
    res.write(`data: ${message}\n\n`);
    const data = JSON.parse(message);
    if (data.percentComplete >= 100 || data.state === 'completed' || data.state === 'failed') {
      res.end();
      subscriber.disconnect();
    }
  });

  req.on('close', () => {
    subscriber.disconnect();
  });

  // Also send current state immediately
  const { data: scan } = await db.from('organic_scans').select('state, points_completed, total_points').eq('id', scanId).single();
  if (scan) {
    const pct = scan.total_points > 0 ? Math.round((scan.points_completed / scan.total_points) * 100) : 0;
    res.write(`data: ${JSON.stringify({ pointsCompleted: scan.points_completed, totalPoints: scan.total_points, percentComplete: pct, state: scan.state })}\n\n`);
    if (scan.state === 'completed' || scan.state === 'failed') {
      res.end();
      subscriber.disconnect();
    }
  }
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, keyword, targetingMethod, radiusKm, gridSize, inputAddresses, inputZipCodes } = req.body;
    if (!businessId || !keyword || !targetingMethod) return res.status(400).json({ error: 'businessId, keyword and targetingMethod required' });

    // Check concurrent scan limit (max 5 per user)
    const canScan = await checkConcurrentScans(req.userId!, 5);
    if (!canScan) throw new RateLimitError(5);

    // Deduct credit via billing domain
    await billingService.checkAndDeductCredits({ userId: req.userId!, amount: 1, reason: `Organic scan: ${keyword}`, transactionType: 'usage' });

    const { data: business } = await db.from('businesses').select('latitude, longitude, name, google_place_id').eq('id', businessId).eq('user_id', req.userId!).single();
    if (!business) return res.status(404).json({ error: 'Business not found' });
    if (!business.latitude || !business.longitude) throw new NoLocationError();

    const radius = parseFloat(radiusKm ?? '5');
    const gSize = parseInt(gridSize ?? '3');

    const { data: scan, error } = await db.from('organic_scans').insert({
      user_id: req.userId, business_id: businessId, keyword,
      targeting_method: targetingMethod, radius_km: radius, grid_size: gSize,
      input_addresses: inputAddresses ?? null, input_zip_codes: inputZipCodes ?? null,
      state: 'pending', credits_consumed: 1,
      scan_date: new Date().toISOString().split('T')[0],
      total_points: 0, points_completed: 0,
    }).select().single();

    if (error) throw new Error(error.message);

    // Generate points and enqueue
    const { data: competitors } = await db.from('competitors').select('id, name, google_place_id').eq('business_id', businessId).eq('is_active', true).order('display_order');

    let points = [];
    if (targetingMethod === 'auto_grid') {
      points = geoService.generateAutoGrid(business.latitude, business.longitude, radius, gSize);
    } else if (targetingMethod === 'addresses' && inputAddresses?.length) {
      points = await geoService.generateAddressPoints(inputAddresses.slice(0, 9));
    } else if (targetingMethod === 'zip_codes' && inputZipCodes?.length) {
      points = await geoService.generateZipCodePoints(inputZipCodes.slice(0, 6), radius);
    }

    if (!points.length) throw new NoScanPointsError();

    await db.from('organic_scans').update({ scan_points: points, total_points: points.length }).eq('id', scan.id);

    await enqueueOrganicScan({
      scanId: scan.id, userId: req.userId, businessId,
      clientGooglePlaceId: business.google_place_id,
      competitors: (competitors ?? []).map(c => ({ id: c.id, name: c.name, googlePlaceId: c.google_place_id })),
      keyword, points, radiusKm: radius,
    });

    logger.info('[Route] Organic scan created', { scanId: scan.id, keyword });
    res.status(201).json({ scanId: scan.id, state: 'pending', totalPoints: points.length });
  } catch (err: any) {
    const status = err.statusCode ?? 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
