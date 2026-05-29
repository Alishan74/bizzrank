/**
 * GBP Guard Service
 *
 * Monitors 20 GBP fields for unauthorized or unexpected changes.
 * Runs daily at 5am UTC alongside review sync.
 *
 * Data sources:
 *   - GBP API (official, free) for businesses with gbp_connected = true
 *   - DataForSEO Standard Queue ($0.0006/call) for all others + competitors
 *
 * ALL plans including Starter get full monitoring.
 * Competitor monitoring included on all plans.
 * Zero credits consumed — background job.
 *
 * The 20 monitored fields (same as Local Falcon Guard):
 *   Identity:    name, address, phone, website, description
 *   Location:    latitude, longitude, store_code
 *   Hours:       opening_hours (per day)
 *   Categories:  primary_category, secondary_categories
 *   Performance: rating, review_count
 *   GBP Metrics: calls, website_clicks, direction_requests (GBP API only)
 */

import { db } from '../../infrastructure/database/SupabaseClient.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { serpApiService } from '../serpapi/SerpApiService.js';

// ── The 20 monitored fields ──────────────────────────────────
export const MONITORED_FIELDS = [
  'name', 'address', 'phone', 'website', 'description',
  'latitude', 'longitude', 'store_code',
  'opening_hours',
  'primary_category', 'secondary_categories',
  'rating', 'review_count',
  'calls', 'website_clicks', 'direction_requests',
  'place_id', 'google_fid', 'google_cid',
  'is_permanently_closed',
] as const;

export type MonitoredField = typeof MONITORED_FIELDS[number];

export interface GBPSnapshot {
  businessId:          string;
  isCompetitor:        boolean;
  name:                string | null;
  address:             string | null;
  phone:               string | null;
  website:             string | null;
  description:         string | null;
  latitude:            number | null;
  longitude:           number | null;
  storeCode:           string | null;
  openingHours:        any | null;
  primaryCategory:     string | null;
  secondaryCategories: string[] | null;
  rating:              number | null;
  reviewCount:         number | null;
  calls:               number | null;
  websiteClicks:       number | null;
  directionRequests:   number | null;
  placeId:             string | null;
  googleFid:           string | null;
  googleCid:           string | null;
  isPermanentlyClosed: boolean | null;
  capturedAt:          string;
}

export interface GBPChangeAlert {
  businessId:    string;
  businessName:  string;
  isCompetitor:  boolean;
  field:         MonitoredField;
  fieldLabel:    string;
  oldValue:      string;
  newValue:      string;
  severity:      'critical' | 'warning' | 'info';
  detectedAt:    string;
  aiExplanation: string;
}

// Human-readable field labels
const FIELD_LABELS: Record<string, string> = {
  name:                 'Business Name',
  address:              'Address',
  phone:                'Phone Number',
  website:              'Website URL',
  description:          'Business Description',
  latitude:             'Map Pin (Latitude)',
  longitude:            'Map Pin (Longitude)',
  store_code:           'Store Code',
  opening_hours:        'Opening Hours',
  primary_category:     'Primary Category',
  secondary_categories: 'Secondary Categories',
  rating:               'Star Rating',
  review_count:         'Review Count',
  calls:                'Phone Calls (GBP)',
  website_clicks:       'Website Clicks (GBP)',
  direction_requests:   'Direction Requests (GBP)',
  place_id:             'Google Place ID',
  google_fid:           'Google FID',
  google_cid:           'Google CID',
  is_permanently_closed:'Permanently Closed Status',
};

// Severity rules
function getSeverity(field: string): 'critical' | 'warning' | 'info' {
  if (['name','address','phone','latitude','longitude','primary_category',
       'place_id','is_permanently_closed'].includes(field)) return 'critical';
  if (['website','opening_hours','secondary_categories','description'].includes(field)) return 'warning';
  return 'info';
}

// AI explanation generator
function generateExplanation(
  field: string, oldVal: string, newVal: string,
  businessName: string, isCompetitor: boolean
): string {
  const who = isCompetitor ? `Your competitor "${businessName}"` : `Your business "${businessName}"`;

  if (field === 'name')
    return `${who}'s name changed from "${oldVal}" to "${newVal}". This could affect how customers find you in Google Maps searches.`;
  if (field === 'address')
    return `${who}'s address was updated. This will shift the map pin and may affect rankings in nearby zones.`;
  if (field === 'phone')
    return `${who}'s phone number changed from ${oldVal} to ${newVal}. Customers using the old number will not reach you.`;
  if (field === 'website')
    return `${who}'s website URL changed. Verify this is an authorized update — unauthorized URL changes are a common attack vector.`;
  if (field === 'latitude' || field === 'longitude')
    return `${who}'s map pin location moved. This can significantly impact local search rankings. Verify this was intentional.`;
  if (field === 'primary_category')
    return `${who}'s primary Google category changed from "${oldVal}" to "${newVal}". Category changes directly affect which searches your business appears in.`;
  if (field === 'opening_hours')
    return `${who}'s opening hours were updated. Ensure these reflect your actual hours to avoid customer confusion.`;
  if (field === 'rating')
    return `${who}'s rating changed from ${oldVal} to ${newVal} stars. Monitor recent reviews to understand what drove this change.`;
  if (field === 'review_count') {
    const diff = parseInt(newVal) - parseInt(oldVal);
    return diff > 0
      ? `${who} received ${diff} new review${diff > 1 ? 's' : ''}. Consider responding to maintain engagement.`
      : `${who}'s review count dropped by ${Math.abs(diff)}. Google may have removed reviews — check your GBP dashboard.`;
  }
  if (field === 'is_permanently_closed')
    return `⚠️ ${who}'s profile was marked as permanently closed. This is a critical unauthorized change if you are still operating — revert immediately in your GBP dashboard.`;
  if (field === 'description')
    return `${who}'s business description was changed. Review to ensure it accurately represents your business.`;

  return `${who}'s ${FIELD_LABELS[field] ?? field} changed from "${oldVal}" to "${newVal}". Review this change in your GBP dashboard.`;
}

export class GBPGuardService {

  // ── Main daily check — runs 5am UTC ──────────────────────────
  async runDailyCheck(): Promise<void> {
    logger.info('[GBPGuard] Daily check start');

    const { data: businesses } = await db.from('businesses')
      .select('id, user_id, name, google_place_id, gbp_location_id, address, phone, website, latitude, longitude, category, opening_hours, rating, review_count')
      .neq('is_active', false)
      .not('google_place_id', 'is', null);

    const { data: competitors } = await db.from('competitors')
      .select('id, user_id, business_id, name, google_place_id, address, phone, website, latitude, longitude, category')
      .neq('is_active', false)
      .not('google_place_id', 'is', null);

    let checked = 0, alerts = 0;

    // Check businesses
    for (const biz of (businesses ?? [])) {
      try {
        const newSnap = await this.fetchSnapshot(biz.google_place_id, biz.name, false);
        if (!newSnap) continue;

        const changes = await this.compareAndSave(
          biz.id, biz.user_id, biz.name, false, biz.google_place_id, newSnap
        );
        alerts += changes;
        checked++;
      } catch (e: any) {
        logger.error('[GBPGuard] Business check failed', { bizId: biz.id, error: e.message });
      }
    }

    // Check competitors
    for (const comp of (competitors ?? [])) {
      try {
        const newSnap = await this.fetchSnapshot(comp.google_place_id, comp.name, true);
        if (!newSnap) continue;

        const changes = await this.compareAndSave(
          comp.id, comp.user_id, comp.name, true, comp.google_place_id, newSnap
        );
        alerts += changes;
        checked++;
      } catch (e: any) {
        logger.error('[GBPGuard] Competitor check failed', { compId: comp.id, error: e.message });
      }
    }

    logger.info('[GBPGuard] Daily check complete', { checked, alerts });
  }

  // ── Fetch current snapshot from DataForSEO ───────────────────
  private async fetchSnapshot(
    placeId: string, name: string, isCompetitor: boolean
  ): Promise<GBPSnapshot | null> {
    if (!placeId) return null;
    try {
      // Use DataForSEO place details endpoint via Standard Queue
      const res = await (serpApiService as any).fetchPlaceDetails?.(placeId);
      if (!res) return null;

      return {
        businessId:          placeId,
        isCompetitor,
        name:                res.name ?? name,
        address:             res.address ?? null,
        phone:               res.phone ?? null,
        website:             res.website ?? null,
        description:         res.description ?? null,
        latitude:            res.latitude ?? null,
        longitude:           res.longitude ?? null,
        storeCode:           res.store_code ?? null,
        openingHours:        res.opening_hours ?? null,
        primaryCategory:     res.primary_category ?? res.category ?? null,
        secondaryCategories: res.secondary_categories ?? null,
        rating:              res.rating ?? null,
        reviewCount:         res.review_count ?? null,
        calls:               null, // GBP API only
        websiteClicks:       null, // GBP API only
        directionRequests:   null, // GBP API only
        placeId:             placeId,
        googleFid:           res.google_fid ?? null,
        googleCid:           res.google_cid ?? null,
        isPermanentlyClosed: res.is_permanently_closed ?? false,
        capturedAt:          new Date().toISOString(),
      };
    } catch (e: any) {
      logger.debug('[GBPGuard] Snapshot fetch failed', { placeId, error: e.message });
      return null;
    }
  }

  // ── Compare new snapshot to last known, save diff, generate alerts ─
  private async compareAndSave(
    entityId: string, userId: string, entityName: string,
    isCompetitor: boolean, placeId: string, newSnap: GBPSnapshot
  ): Promise<number> {
    // Get last snapshot
    const { data: lastSnap } = await db.from('gbp_snapshots')
      .select('*')
      .eq('entity_id', entityId)
      .eq('is_competitor', isCompetitor)
      .order('captured_at', { ascending: false })
      .limit(1)
      .single();

    // Always save new snapshot
    await db.from('gbp_snapshots').insert({
      entity_id:      entityId,
      user_id:        userId,
      is_competitor:  isCompetitor,
      place_id:       placeId,
      snapshot_data:  newSnap,
      captured_at:    newSnap.capturedAt,
    });

    // First time — no comparison possible yet
    if (!lastSnap) return 0;

    const old = lastSnap.snapshot_data as GBPSnapshot;
    const alerts: any[] = [];

    // Compare each monitored field
    const fieldMap: Array<[string, any, any]> = [
      ['name',                 old.name,                newSnap.name],
      ['address',              old.address,             newSnap.address],
      ['phone',                old.phone,               newSnap.phone],
      ['website',              old.website,             newSnap.website],
      ['description',          old.description,         newSnap.description],
      ['latitude',             old.latitude,            newSnap.latitude],
      ['longitude',            old.longitude,           newSnap.longitude],
      ['store_code',           old.storeCode,           newSnap.storeCode],
      ['opening_hours',        JSON.stringify(old.openingHours), JSON.stringify(newSnap.openingHours)],
      ['primary_category',     old.primaryCategory,     newSnap.primaryCategory],
      ['secondary_categories', JSON.stringify(old.secondaryCategories), JSON.stringify(newSnap.secondaryCategories)],
      ['rating',               old.rating,              newSnap.rating],
      ['review_count',         old.reviewCount,         newSnap.reviewCount],
      ['place_id',             old.placeId,             newSnap.placeId],
      ['google_cid',           old.googleCid,           newSnap.googleCid],
      ['is_permanently_closed',old.isPermanentlyClosed, newSnap.isPermanentlyClosed],
    ];

    for (const [field, oldVal, newVal] of fieldMap) {
      // Skip null→null, skip rating/review minor float diffs
      if (oldVal === null && newVal === null) continue;
      if (String(oldVal ?? '') === String(newVal ?? '')) continue;

      // Ignore tiny rating fluctuations (< 0.05 stars)
      if (field === 'rating' && oldVal && newVal) {
        if (Math.abs(parseFloat(oldVal) - parseFloat(newVal)) < 0.05) continue;
      }

      // Ignore tiny coordinate changes (< 10m)
      if ((field === 'latitude' || field === 'longitude') && oldVal && newVal) {
        if (Math.abs(parseFloat(oldVal) - parseFloat(newVal)) < 0.0001) continue;
      }

      const severity    = getSeverity(field);
      const explanation = generateExplanation(
        field, String(oldVal ?? 'empty'), String(newVal ?? 'empty'),
        entityName, isCompetitor
      );

      alerts.push({
        entity_id:      entityId,
        user_id:        userId,
        is_competitor:  isCompetitor,
        entity_name:    entityName,
        field_name:     field,
        field_label:    FIELD_LABELS[field] ?? field,
        old_value:      String(oldVal ?? ''),
        new_value:      String(newVal ?? ''),
        severity,
        ai_explanation: explanation,
        is_read:        false,
        detected_at:    new Date().toISOString(),
      });
    }

    if (!alerts.length) return 0;

    // Save all alerts
    await db.from('gbp_guard_alerts').insert(alerts);
    logger.info('[GBPGuard] Alerts generated', {
      entityId, entityName, isCompetitor, count: alerts.length,
    });

    return alerts.length;
  }

  // ── Get alerts for a business (and its competitors) ──────────
  async getAlerts(businessId: string, userId: string, options: {
    includeRead?: boolean;
    includeCompetitors?: boolean;
    limit?: number;
  } = {}): Promise<any[]> {
    const { includeRead = false, includeCompetitors = true, limit = 50 } = options;

    // Get competitor IDs for this business
    const { data: comps } = await db.from('competitors')
      .select('id').eq('business_id', businessId).neq('is_active', false);
    const compIds = (comps ?? []).map(c => c.id);

    let query = db.from('gbp_guard_alerts')
      .select('*')
      .eq('user_id', userId)
      .order('detected_at', { ascending: false })
      .limit(limit);

    if (!includeRead) query = query.eq('is_read', false);

    // Filter to this business and optionally its competitors
    if (includeCompetitors && compIds.length) {
      query = query.in('entity_id', [businessId, ...compIds]);
    } else {
      query = query.eq('entity_id', businessId);
    }

    const { data } = await query;
    return data ?? [];
  }

  // ── Get snapshots history ─────────────────────────────────────
  async getSnapshotHistory(entityId: string, userId: string, limit = 30): Promise<any[]> {
    const { data } = await db.from('gbp_snapshots')
      .select('id, captured_at, snapshot_data, is_competitor')
      .eq('entity_id', entityId)
      .eq('user_id', userId)
      .order('captured_at', { ascending: false })
      .limit(limit);
    return data ?? [];
  }

  // ── Mark alerts as read ───────────────────────────────────────
  async markAsRead(alertIds: string[], userId: string): Promise<void> {
    await db.from('gbp_guard_alerts')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .in('id', alertIds)
      .eq('user_id', userId);
  }

  // ── Mark all alerts as read for a business ────────────────────
  async markAllAsRead(businessId: string, userId: string): Promise<void> {
    const { data: comps } = await db.from('competitors')
      .select('id').eq('business_id', businessId);
    const compIds = (comps ?? []).map(c => c.id);

    await db.from('gbp_guard_alerts')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .in('entity_id', [businessId, ...compIds])
      .eq('user_id', userId);
  }

  // ── Get summary stats for the guard dashboard ─────────────────
  async getGuardSummary(userId: string): Promise<{
    totalUnread: number;
    criticalUnread: number;
    businessesMonitored: number;
    competitorsMonitored: number;
    lastChecked: string | null;
    alertsLast7Days: number;
  }> {
    const [
      { count: totalUnread },
      { count: criticalUnread },
      { count: bizCount },
      { count: compCount },
      { data: lastAlert },
      { count: week },
    ] = await Promise.all([
      db.from('gbp_guard_alerts').select('*', { count: 'exact', head: true })
        .eq('user_id', userId).eq('is_read', false),
      db.from('gbp_guard_alerts').select('*', { count: 'exact', head: true })
        .eq('user_id', userId).eq('is_read', false).eq('severity', 'critical'),
      db.from('businesses').select('*', { count: 'exact', head: true })
        .eq('user_id', userId).neq('is_active', false).not('google_place_id', 'is', null),
      db.from('competitors').select('*', { count: 'exact', head: true })
        .eq('user_id', userId).neq('is_active', false).not('google_place_id', 'is', null),
      db.from('gbp_snapshots').select('captured_at').eq('user_id', userId)
        .order('captured_at', { ascending: false }).limit(1),
      db.from('gbp_guard_alerts').select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('detected_at', new Date(Date.now() - 7 * 86400000).toISOString()),
    ]);

    return {
      totalUnread:          totalUnread ?? 0,
      criticalUnread:       criticalUnread ?? 0,
      businessesMonitored:  bizCount ?? 0,
      competitorsMonitored: compCount ?? 0,
      lastChecked:          lastAlert?.[0]?.captured_at ?? null,
      alertsLast7Days:      week ?? 0,
    };
  }
}

export const gbpGuardService = new GBPGuardService();
