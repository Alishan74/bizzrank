/**
 * Custom Scans — /api/custom-scans
 *
 * Standalone scans from any center point, any keyword.
 * NOT tied to any business. Does NOT affect intelligence history.
 * Both organic ranking and ad pressure from same API call.
 * 25 credits per scan — uses user credit pool.
 */
import { Router } from 'express';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { billingService, CREDIT_COSTS } from '../../domains/billing/BillingService.js';
import { geoService } from '../../domains/geo/GeoService.js';
import { serpApiService } from '../../domains/serpapi/SerpApiService.js';
import { logger } from '../../infrastructure/logger/Logger.js';

const router = Router();

// GET /api/custom-scans — list history
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { data } = await db.from('custom_scans')
    .select('*').eq('user_id', req.userId!)
    .order('created_at', { ascending: false }).limit(50);
  res.json({ scans: data ?? [] });
});

// GET /api/custom-scans/:id — single result
router.get('/:id', requireAuth, async (req: AuthRequest, res) => {
  const { data } = await db.from('custom_scans')
    .select('*').eq('id', req.params.id).eq('user_id', req.userId!).single();
  if (!data) return res.status(404).json({ error: 'Scan not found' });
  res.json({ scan: data });
});

// POST /api/custom-scans — run a custom scan
// Body: { keyword, centerLat, centerLng, centerAddress, radiusKm?, scanType? }
// scanType: 'organic' | 'ad_pressure' | 'both' (default: 'both')
router.post('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    const {
      keyword, centerLat, centerLng, centerAddress,
      radiusKm = 5, scanType = 'both',
    } = req.body;

    if (!keyword?.trim())   return res.status(400).json({ error: 'keyword required' });
    if (!centerLat || !centerLng) return res.status(400).json({ error: 'centerLat and centerLng required' });

    const lat = parseFloat(centerLat);
    const lng = parseFloat(centerLng);
    const r   = parseFloat(radiusKm);

    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'Invalid coordinates' });

    // Create record FIRST — then deduct credits
    const { data: scan, error: scanErr } = await db.from('custom_scans').insert({
      user_id:        req.userId,
      scan_type:      scanType,
      keyword:        keyword.trim().toLowerCase(),
      center_lat:     lat,
      center_lng:     lng,
      center_address: centerAddress ?? null,
      radius_km:      r,
      grid_size:      3,
      state:          'running',
      total_points:   25,
      points_completed: 0,
      credits_consumed: CREDIT_COSTS.MANUAL_SCAN,
      scan_date:      new Date().toISOString().split('T')[0],
    }).select().single();

    if (scanErr || !scan) throw new Error(scanErr?.message ?? 'Failed to create scan');

    // Deduct credits AFTER record created
    await billingService.checkAndDeductCredits({
      userId: req.userId!, amount: CREDIT_COSTS.MANUAL_SCAN,
      reason: `Custom scan: ${keyword} @ ${lat.toFixed(4)},${lng.toFixed(4)}`,
      transactionType: 'usage',
    });

    // Run scan asynchronously — respond immediately
    res.status(201).json({
      scanId:          scan.id,
      state:           'running',
      creditsConsumed: CREDIT_COSTS.MANUAL_SCAN,
      message:         'Scan started. Results will appear in Custom Scans history.',
    });

    // Run in background — don't await
    runCustomScan(scan.id, req.userId!, lat, lng, keyword.trim().toLowerCase(), r, scanType)
      .catch(err => {
        logger.error('[CustomScan] Background scan failed', { scanId: scan.id, error: err.message });
        db.from('custom_scans').update({ state: 'failed' }).eq('id', scan.id).catch(() => {});
      });

  } catch (err: any) {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  }
});

// Address autocomplete for the location picker
router.get('/address-autocomplete', requireAuth, async (req: AuthRequest, res) => {
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

// ── Background scan execution ─────────────────────────────────
async function runCustomScan(
  scanId: string, userId: string,
  lat: number, lng: number,
  keyword: string, radiusKm: number,
  scanType: string
): Promise<void> {
  const points = geoService.generateAutoGrid(lat, lng, radiusKm, 3);
  const organicPoints: any[]   = [];
  const sponsoredPoints: any[] = [];

  const BATCH = 3;
  let done = 0;

  for (let i = 0; i < points.length; i += BATCH) {
    await Promise.all(points.slice(i, i + BATCH).map(async (pt) => {
      const res = await serpApiService.search(pt.lat, pt.lng, keyword, radiusKm * 1000, 'MANUAL_SCAN', scanId);
      const loc = await geoService.reverseGeocode(pt.lat, pt.lng);

      if (scanType === 'organic' || scanType === 'both') {
        const rank = res.organic.find(r => r.rank === 1) ?? null;
        organicPoints.push({
          lat: pt.lat, lng: pt.lng, label: pt.label, locationName: loc,
          rank: rank?.rank ?? null, businessName: rank?.name ?? null,
          intensity: rank ? Math.max(0, 1 - (rank.rank - 1) / 20) : 0,
          googleMapsUrl: pt.googleMapsUrl,
          allResults: res.organic.slice(0, 5).map(r => ({ name: r.name, rank: r.rank, placeId: r.placeId })),
        });
      }

      if (scanType === 'ad_pressure' || scanType === 'both') {
        sponsoredPoints.push({
          lat: pt.lat, lng: pt.lng, label: pt.label, locationName: loc,
          adCount: res.sponsored.length, hasAds: res.sponsored.length > 0,
          googleMapsUrl: pt.googleMapsUrl,
          topAdvertisers: res.sponsored.slice(0, 3).map(r => ({ name: r.name, rank: r.rank, placeId: r.placeId })),
        });
      }
    }));
    done = Math.min(i + BATCH, points.length);
    await db.from('custom_scans').update({ points_completed: done }).eq('id', scanId);
    if (i + BATCH < points.length) await new Promise(r => setTimeout(r, 400));
  }

  // Compute visibility score for organic
  const ranks = organicPoints.map(p => p.rank).filter(r => r !== null);
  const visScore = points.length > 0
    ? (ranks.reduce((s: number, r: number) => s + Math.max(0, 1 - (r - 1) / 20), 0) / points.length) * 100 : 0;

  await db.from('custom_scans').update({
    state:             'completed',
    organic_results:   organicPoints.length > 0 ? organicPoints : null,
    sponsored_results: sponsoredPoints.length > 0 ? sponsoredPoints : null,
    visibility_score:  Math.round(visScore * 100) / 100,
    points_completed:  points.length,
    completed_at:      new Date().toISOString(),
  }).eq('id', scanId);

  logger.info('[CustomScan] Complete', { scanId, keyword, visScore });
}

export default router;
