/**
 * Geo Domain — GeoService
 * UPDATED: Permanent geo cache (Supabase + Redis).
 * reverseGeocode now checks Supabase geo_cache before calling Google Maps API.
 * After the first week of scans, geocoding API calls approach zero.
 */

import { latLngToCell, gridDisk, cellToLatLng, gridRingUnsafe } from 'h3-js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { getGeoCache, setGeoCache } from '../../infrastructure/cache/CacheService.js';
import type { ScanPoint } from '../../shared/types/contracts.js';
import 'dotenv/config';

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY!;

export class GeoService {

  private makeGeoDbKey(lat: number, lng: number): string {
    // 3 decimal places = ~110m precision — good enough for neighborhood names
    return `${Math.round(lat * 1000) / 1000}:${Math.round(lng * 1000) / 1000}`;
  }

  /**
   * Reverse geocode with 3-layer cache:
   *   1. Redis (30-day TTL, sub-millisecond)
   *   2. Supabase geo_cache table (permanent, survives Redis flush)
   *   3. Google Maps API (only on first-ever request for this coordinate)
   *
   * After the first scan week, ~100% of calls hit cache layers 1 or 2.
   * Google Maps geocoding cost becomes negligible.
   */
  async reverseGeocode(lat: number, lng: number): Promise<string> {
    // Layer 1: Redis hot cache
    const redisCached = await getGeoCache(lat, lng);
    if (redisCached) return redisCached;

    // Layer 2: Supabase permanent cache
    const dbKey = this.makeGeoDbKey(lat, lng);
    try {
      const { data: dbCached } = await db
        .from('geo_cache')
        .select('location_name')
        .eq('lat_lng', dbKey)
        .single();
      if (dbCached?.location_name) {
        // Warm Redis from DB
        await setGeoCache(lat, lng, dbCached.location_name);
        return dbCached.location_name;
      }
    } catch { /* geo_cache miss is expected — fall through */ }

    // Layer 3: Google Maps API (only fires if coordinate is genuinely new)
    const name = await this.callGoogleGeocode(lat, lng);

    // Store in both caches permanently
    await setGeoCache(lat, lng, name);
    try {
      await db.from('geo_cache').upsert(
        { lat_lng: dbKey, location_name: name },
        { onConflict: 'lat_lng', ignoreDuplicates: true }
      );
    } catch { /* non-critical */ }

    return name;
  }

  private async callGoogleGeocode(lat: number, lng: number): Promise<string> {
    try {
      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      url.searchParams.set('latlng', `${lat},${lng}`);
      url.searchParams.set('key', MAPS_KEY);
      const d = await fetch(url.toString()).then(r => r.json()) as any;
      if (d.status !== 'OK' || !d.results?.length) {
        return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      }
      const components = d.results[0].address_components;
      const neighborhood = components.find((c: any) => c.types.includes('neighborhood'))?.long_name;
      const sublocality  = components.find((c: any) => c.types.includes('sublocality'))?.long_name;
      const route        = components.find((c: any) => c.types.includes('route'))?.long_name;
      const locality     = components.find((c: any) => c.types.includes('locality'))?.long_name;
      return neighborhood ?? sublocality ?? route ?? locality ?? d.results[0].formatted_address;
    } catch {
      return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    }
  }

  private selectResolution(radiusKm: number): number {
    if (radiusKm <= 5)  return 9;
    if (radiusKm <= 20) return 8;
    return 6;
  }

  generateAutoGrid(
    centerLat: number, centerLng: number,
    radiusKm: number, gridSize: number
  ): ScanPoint[] {
    const resolution = this.selectResolution(radiusKm);
    const centerCell = latLngToCell(centerLat, centerLng, resolution);
    const rings  = Math.max(1, Math.min(gridSize, 10));
    const cells  = gridDisk(centerCell, rings);
    const MAX    = 25;
    const step   = Math.max(1, Math.floor(cells.length / MAX));

    return cells
      .filter((_, i) => i % step === 0)
      .slice(0, MAX)
      .map((cell, i) => {
        const [lat, lng] = cellToLatLng(cell);
        return {
          lat, lng,
          index: i + 1,
          label: `Grid point ${i + 1}`,
          locationName: '', // filled by reverseGeocode during scan
          googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
          source: 'auto_grid' as const,
        };
      });
  }

  async generateAddressPoints(
    addresses: Array<{ address: string; lat?: number; lng?: number }>
  ): Promise<ScanPoint[]> {
    const points: ScanPoint[] = [];
    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i];
      if (addr.lat && addr.lng) {
        points.push({
          lat: addr.lat, lng: addr.lng, index: i + 1,
          label: addr.address, locationName: addr.address,
          googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${addr.lat},${addr.lng}`,
          source: 'address',
        });
        continue;
      }
      const coords = await this.geocodeAddress(addr.address);
      if (coords) {
        points.push({
          lat: coords.lat, lng: coords.lng, index: i + 1,
          label: addr.address, locationName: addr.address,
          googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`,
          source: 'address',
        });
      }
    }
    return points;
  }

  async generateZipCodePoints(zipCodes: string[], radiusKm = 3): Promise<ScanPoint[]> {
    const points: ScanPoint[] = [];
    for (const zip of zipCodes.slice(0, 6)) {
      const center = await this.geocodeAddress(zip);
      if (!center) continue;
      const resolution = this.selectResolution(radiusKm);
      const centerCell = latLngToCell(center.lat, center.lng, resolution);
      let ring1: string[] = [];
      try { ring1 = gridRingUnsafe(centerCell, 1); }
      catch { ring1 = gridDisk(centerCell, 1).slice(1, 4); }
      [centerCell, ...ring1.slice(0, 3)].forEach((cell, j) => {
        const [lat, lng] = cellToLatLng(cell);
        points.push({
          lat, lng, index: points.length + 1,
          label: `${zip} — point ${j + 1}`, locationName: zip,
          googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
          source: 'zip_code',
        });
      });
    }
    return points;
  }

  async geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
    try {
      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      url.searchParams.set('address', address);
      url.searchParams.set('key', MAPS_KEY);
      const d = await fetch(url.toString()).then(r => r.json()) as any;
      if (d.status !== 'OK' || !d.results?.length) return null;
      return {
        lat: d.results[0].geometry.location.lat,
        lng: d.results[0].geometry.location.lng,
      };
    } catch { return null; }
  }

  generateScanSchedule(openTime: string, closeTime: string, intervalMinutes = 60): string[] {
    const times: string[] = [];
    const [oh, om] = openTime.split(':').map(Number);
    const [ch, cm] = closeTime.split(':').map(Number);
    let current = oh * 60 + om;
    const close = ch * 60 + cm;
    while (current <= close) {
      const h = Math.floor(current / 60).toString().padStart(2, '0');
      const m = (current % 60).toString().padStart(2, '0');
      times.push(`${h}:${m}`);
      current += intervalMinutes;
    }
    return times;
  }

  getTodayHours(openingHours: any): { open: string; close: string } | null {
    if (!openingHours) return null;
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const today = days[new Date().getDay()];
    const hours = openingHours[today];
    if (!hours?.open || !hours?.close) return null;
    return { open: hours.open, close: hours.close };
  }
}

export const geoService = new GeoService();
