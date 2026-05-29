/**
 * Ad Pressure Domain
 * Owns all ad scan logic.
 * Uses SerpApi for 100% accurate sponsored detection.
 * Jobs scheduled via BullMQ with precise delays.
 */

import { db } from '../../infrastructure/database/SupabaseClient.js';
import { eventBus, Events } from '../../infrastructure/events/EventBus.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { serpApiService } from '../serpapi/SerpApiService.js';
import { geoService } from '../geo/GeoService.js';
import { Worker, type Job } from 'bullmq';
import { createBullMQConnection } from '../../infrastructure/cache/RedisClient.js';
import type { AdSlotJob, AdDensityPoint } from '../../shared/types/contracts.js';

export class AdPressureService {
  async processAdSlot(job: AdSlotJob): Promise<void> {
    const { slotId, sessionId, userId, businessId, keyword, radiusKm, targetingMethod, inputAddresses, inputZipCodes, gridSize } = job;

    const { data: session } = await db.from('ad_scan_sessions').select('state').eq('id', sessionId).single();
    if (session?.state === 'stopped') {
      await db.from('ad_scan_slots').update({ state: 'skipped' }).eq('id', slotId);
      return;
    }

    await db.from('ad_scan_slots').update({ state: 'running', started_at: new Date().toISOString() }).eq('id', slotId);

    const { data: biz } = await db.from('businesses').select('latitude, longitude, google_place_id').eq('id', businessId).single();
    if (!biz?.latitude || !biz?.longitude) throw new Error('Business has no coordinates');

    // Generate scan points
    let points = [];
    if (targetingMethod === 'auto_grid') {
      points = geoService.generateAutoGrid(biz.latitude, biz.longitude, radiusKm, gridSize);
    } else if (targetingMethod === 'addresses' && inputAddresses?.length) {
      points = await geoService.generateAddressPoints(inputAddresses);
    } else if (targetingMethod === 'zip_codes' && inputZipCodes?.length) {
      points = await geoService.generateZipCodePoints(inputZipCodes, radiusKm);
    }

    await db.from('ad_scan_slots').update({ scan_points: points }).eq('id', slotId);

    const allOrganic: any[] = [];
    const allSponsored: any[] = [];

    for (let i = 0; i < points.length; i += 3) {
      const batch = points.slice(i, i + 3);
      await Promise.all(batch.map(async (point: any) => {
        const results = await serpApiService.search(point.lat, point.lng, keyword, radiusKm * 1000, 'AD_PRESSURE', job.sessionId);
        results.organic.forEach(r => allOrganic.push({ ...r, pointIndex: point.index, lat: point.lat, lng: point.lng, label: point.label, locationName: point.locationName }));
        results.sponsored.forEach(r => allSponsored.push({ ...r, pointIndex: point.index, lat: point.lat, lng: point.lng, label: point.label, locationName: point.locationName }));
      }));
      await new Promise(r => setTimeout(r, 300));
    }

    // Build density map
    const sponsoredByPoint = new Map<number, any[]>();
    allSponsored.forEach(r => {
      if (!sponsoredByPoint.has(r.pointIndex)) sponsoredByPoint.set(r.pointIndex, []);
      sponsoredByPoint.get(r.pointIndex)!.push(r);
    });

    const pointsWithAds = sponsoredByPoint.size;
    const pressureScore = points.length > 0 ? (pointsWithAds / points.length) * 100 : 0;
    const uniqueAdvertisers = new Set(allSponsored.map(r => r.placeId)).size;

    const densityMap: AdDensityPoint[] = points.map((p: any) => ({
      lat: p.lat, lng: p.lng, label: p.label, locationName: p.locationName,
      adCount: sponsoredByPoint.get(p.index)?.length ?? 0,
      hasAds: sponsoredByPoint.has(p.index),
      googleMapsUrl: p.googleMapsUrl,
      topAdvertisers: (sponsoredByPoint.get(p.index) ?? []).slice(0, 3).map((r: any) => ({ name: r.name, rank: r.rank, placeId: r.placeId })),
    }));

    await db.from('ad_scan_slots').update({
      state: 'completed',
      ad_results: allSponsored,
      organic_results: allOrganic,
      pressure_score: Math.round(pressureScore * 100) / 100,
      advertiser_count: uniqueAdvertisers,
      organic_count: allOrganic.length,
      ad_density_map: densityMap,
      completed_at: new Date().toISOString(),
    }).eq('id', slotId);

    // Update session progress
    const { data: sess } = await db.from('ad_scan_sessions').select('scans_completed, scans_total').eq('id', sessionId).single();
    if (sess) {
      const newCompleted = (sess.scans_completed ?? 0) + 1;
      const isDone = newCompleted >= sess.scans_total;
      await db.from('ad_scan_sessions').update({
        scans_completed: newCompleted,
        state: isDone ? 'completed' : 'running',
        completed_at: isDone ? new Date().toISOString() : null,
      }).eq('id', sessionId);
    }

    eventBus.publish(Events.SCAN_AD_SLOT_COMPLETED, { slotId, sessionId, pressureScore, uniqueAdvertisers });
    logger.info('[AdPressure] Slot complete', { slotId, pressureScore, uniqueAdvertisers });
  }
}

export const adPressureService = new AdPressureService();

// ─── AD SLOT WORKER ───────────────────────────────────────────
let adWorker: Worker | null = null;

export function startAdSlotWorker(): void {
  adWorker = new Worker(
    'ad-scan-slots',
    async (job: Job) => {
      logger.info('[AdWorker] Processing slot', { jobId: job.id, slotId: job.data.slotId });
      await adPressureService.processAdSlot(job.data);
    },
    {
      connection: createBullMQConnection(),
      concurrency: 20, // 20 slots simultaneously
    }
  );

  adWorker.on('failed', async (job, err) => {
    logger.error('[AdWorker] Slot failed', { jobId: job?.id, error: err.message });
    if (job?.data?.slotId) {
      await db.from('ad_scan_slots').update({ state: 'failed' }).eq('id', job.data.slotId);
    }
  });

  logger.info('[AdWorker] Ad slot worker started — concurrency: 20');
}

export async function stopAdSlotWorker(): Promise<void> {
  if (adWorker) await adWorker.close();
}
