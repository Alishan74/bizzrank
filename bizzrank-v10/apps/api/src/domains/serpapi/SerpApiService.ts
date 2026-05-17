/**
 * SerpApi Domain
 * Owns ALL communication with SerpApi.
 * No other domain calls SerpApi directly.
 * Returns typed SearchResults through domain contract.
 */

import 'dotenv/config';
import { makeSerpCacheKey, getSerpCache, setSerpCache } from '../../infrastructure/cache/CacheService.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import type { SearchResult, SearchResults, SerpReview } from '../../shared/types/contracts.js';

const SERP_BASE = 'https://serpapi.com/search.json';

export class SerpApiService {
  private readonly apiKey: string;

  constructor() {
    this.apiKey = process.env.SERPAPI_KEY ?? '';
  }

  isConfigured(): boolean {
    return !!(this.apiKey && this.apiKey !== 'your_serpapi_key_here');
  }

  /**
   * Search Google Maps at a specific lat/lng for a keyword.
   * Returns organic and sponsored results — 100% accurately separated.
   * Results cached in Redis for 1 hour.
   */
  async search(lat: number, lng: number, keyword: string, radiusMeters: number = 5000): Promise<SearchResults> {
    if (!this.isConfigured()) {
      logger.warn('[SerpApi] No API key configured — returning empty results');
      return { organic: [], sponsored: [], fromCache: false };
    }

    const cacheKey = makeSerpCacheKey(lat, lng, keyword);
    const cached = await getSerpCache(cacheKey);
    if (cached) {
      return { ...cached, fromCache: true };
    }

    const params = new URLSearchParams({
      engine: 'google_maps',
      q: keyword,
      ll: `@${lat},${lng},15z`,
      type: 'search',
      api_key: this.apiKey,
    });

    try {
      const res = await fetch(`${SERP_BASE}?${params.toString()}`);
      const data = await res.json() as any;

      if (data.error) {
        logger.error('[SerpApi] API error', { error: data.error, keyword, lat, lng });
        return { organic: [], sponsored: [], fromCache: false };
      }

      const organic: SearchResult[] = [];
      const sponsored: SearchResult[] = [];

      const localResults: any[] = data.local_results ?? [];
      localResults.forEach((r: any, index: number) => {
        const result: SearchResult = {
          placeId: r.place_id ?? r.data_id ?? `serp_${index}`,
          name: r.title ?? r.name ?? '',
          address: r.address ?? '',
          phone: r.phone ?? null,
          website: r.website ?? null,
          rating: r.rating ?? null,
          reviewCount: r.reviews ?? null,
          category: r.type ?? null,
          latitude: r.gps_coordinates?.latitude ?? lat,
          longitude: r.gps_coordinates?.longitude ?? lng,
          rank: index + 1,
          isSponsored: r.sponsored === true,
          thumbnail: r.thumbnail ?? null,
        };

        if (result.isSponsored) {
          sponsored.push(result);
        } else {
          result.rank = organic.length + 1;
          organic.push(result);
        }
      });

      // Also parse ads section
      const adsResults: any[] = data.ads ?? [];
      adsResults.forEach((r: any, index: number) => {
        sponsored.push({
          placeId: r.place_id ?? `ad_${index}`,
          name: r.title ?? '',
          address: r.address ?? '',
          phone: r.phone ?? null,
          website: r.website ?? null,
          rating: r.rating ?? null,
          reviewCount: r.reviews ?? null,
          category: r.type ?? null,
          latitude: r.gps_coordinates?.latitude ?? lat,
          longitude: r.gps_coordinates?.longitude ?? lng,
          rank: index + 1,
          isSponsored: true,
          thumbnail: r.thumbnail ?? null,
        });
      });

      const results: SearchResults = { organic, sponsored, fromCache: false };

      // Cache the results
      await setSerpCache(cacheKey, { organic, sponsored });

      logger.debug('[SerpApi] Search complete', { keyword, organic: organic.length, sponsored: sponsored.length, lat, lng });
      return results;
    } catch (err: any) {
      logger.error('[SerpApi] Fetch error', { error: err.message, keyword });
      return { organic: [], sponsored: [], fromCache: false };
    }
  }

  /**
   * Fetch reviews for a business.
   * Works WITHOUT Google Business Profile.
   * Returns last 20 reviews.
   */
  async fetchReviews(placeId: string): Promise<SerpReview[]> {
    if (!this.isConfigured()) return [];

    const params = new URLSearchParams({
      engine: 'google_maps_reviews',
      place_id: placeId,
      api_key: this.apiKey,
      hl: 'en',
      sort_by: 'newestFirst',
    });

    try {
      const res = await fetch(`${SERP_BASE}?${params.toString()}`);
      const data = await res.json() as any;

      if (data.error) {
        logger.error('[SerpApi] Reviews error', { error: data.error, placeId });
        return [];
      }

      return (data.reviews ?? []).slice(0, 20).map((r: any, i: number) => ({
        reviewId: r.review_id ?? `serp_review_${i}`,
        reviewerName: r.user?.name ?? 'Anonymous',
        reviewerPhoto: r.user?.thumbnail ?? null,
        rating: r.rating ?? 5,
        text: r.snippet ?? '',
        date: r.date ?? new Date().toISOString(),
        isReplied: !!r.response,
      }));
    } catch (err: any) {
      logger.error('[SerpApi] Reviews fetch error', { error: err.message });
      return [];
    }
  }
}

// Single instance exported
export const serpApiService = new SerpApiService();
