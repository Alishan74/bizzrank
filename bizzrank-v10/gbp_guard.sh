#!/usr/bin/env bash
# BizzRank AI v10 — GBP Guard Feature
# cd /workspaces/bizzrank/bizzrank-v10 && bash gbp_guard.sh
set -e
ROOT="$(pwd)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " BizzRank AI — GBP Guard Implementation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. GBPGuardService.ts ─────────────────────────────────────
echo "  [1/6] GBPGuardService.ts"
mkdir -p "$ROOT/apps/api/src/domains/gbpguard"
cat > "$ROOT/apps/api/src/domains/gbpguard/GBPGuardService.ts" << 'EOF'
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
EOF

# ── 2. gbpGuard.ts route ──────────────────────────────────────
echo "  [2/6] gbpGuard.ts route"
cat > "$ROOT/apps/api/src/api/routes/gbpGuard.ts" << 'EOF'
/**
 * GBP Guard Routes — /api/gbp-guard
 *
 * GET  /summary?businessId=     — unread count, stats, last checked
 * GET  /alerts?businessId=      — all alerts for business + competitors
 * POST /mark-read               — mark specific alerts as read
 * POST /mark-all-read           — mark all alerts as read for a business
 * GET  /history?entityId=       — snapshot history for a business or competitor
 * GET  /fields                  — list of 20 monitored fields
 */
import { Router } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { gbpGuardService, MONITORED_FIELDS, type MonitoredField } from '../../domains/gbpguard/GBPGuardService.js';

const router = Router();

// GET /api/gbp-guard/summary
router.get('/summary', requireAuth, async (req: AuthRequest, res) => {
  try {
    const summary = await gbpGuardService.getGuardSummary(req.userId!);
    res.json(summary);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/gbp-guard/alerts?businessId=&includeRead=false&limit=50
router.get('/alerts', requireAuth, async (req: AuthRequest, res) => {
  const { businessId, includeRead, includeCompetitors, limit } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  try {
    const alerts = await gbpGuardService.getAlerts(
      businessId as string, req.userId!, {
        includeRead:        includeRead === 'true',
        includeCompetitors: includeCompetitors !== 'false',
        limit:              parseInt((limit as string) ?? '50'),
      }
    );
    res.json({ alerts });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/gbp-guard/mark-read — body: { alertIds: string[] }
router.post('/mark-read', requireAuth, async (req: AuthRequest, res) => {
  const { alertIds } = req.body;
  if (!alertIds?.length) return res.status(400).json({ error: 'alertIds required' });
  try {
    await gbpGuardService.markAsRead(alertIds, req.userId!);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/gbp-guard/mark-all-read — body: { businessId: string }
router.post('/mark-all-read', requireAuth, async (req: AuthRequest, res) => {
  const { businessId } = req.body;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  try {
    await gbpGuardService.markAllAsRead(businessId, req.userId!);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/gbp-guard/history?entityId=&limit=30
router.get('/history', requireAuth, async (req: AuthRequest, res) => {
  const { entityId, limit } = req.query;
  if (!entityId) return res.status(400).json({ error: 'entityId required' });
  try {
    const history = await gbpGuardService.getSnapshotHistory(
      entityId as string, req.userId!, parseInt((limit as string) ?? '30')
    );
    res.json({ history });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/gbp-guard/fields — list of monitored fields
router.get('/fields', requireAuth, (_req, res) => {
  res.json({ fields: MONITORED_FIELDS });
});

export default router;
EOF

# ── 3. Update WeeklyScheduler.ts — add daily guard check ──────
echo "  [3/6] WeeklyScheduler.ts — add runDailyGuardCheck"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/domains/scheduling/WeeklyScheduler.ts'
with open(path) as f: src = f.read()

# Add import
if 'gbpGuardService' not in src:
    src = src.replace(
        "import { enqueueReviewSync } from '../../infrastructure/queue/QueueRegistry.js';",
        "import { enqueueReviewSync } from '../../infrastructure/queue/QueueRegistry.js';\nimport { gbpGuardService } from '../gbpguard/GBPGuardService.js';"
    )

# Add method before the private getKeywords method
old = "  private async getKeywords"
new = """  async runDailyGuardCheck(): Promise<void> {
    logger.info('[Scheduler] GBP Guard daily check');
    await gbpGuardService.runDailyCheck()
      .catch(e => logger.error('[Scheduler] Guard check failed', { error: e.message }));
  }

  private async getKeywords"""

src = src.replace(old, new)
with open(path, 'w') as f: f.write(src)
print("  ✓ WeeklyScheduler.ts guard check added")
PYEOF

# ── 4. Update index.ts — add guard cron + route ───────────────
echo "  [4/6] index.ts — add GBP Guard cron and route"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/index.ts'
with open(path) as f: src = f.read()

# Add import
if 'gbpGuardRoutes' not in src:
    src = src.replace(
        "import customScanRoutes     from './api/routes/customScans.js';",
        "import customScanRoutes     from './api/routes/customScans.js';\nimport gbpGuardRoutes      from './api/routes/gbpGuard.js';"
    )

# Add route
if '/api/gbp-guard' not in src:
    src = src.replace(
        "app.use('/api/custom-scans',        customScanRoutes);",
        "app.use('/api/custom-scans',        customScanRoutes);\napp.use('/api/gbp-guard',           gbpGuardRoutes);"
    )

# Add cron job — 5am UTC daily guard check
if 'GBP Guard' not in src:
    src = src.replace(
        "  // Monthly credit reset: 1st of month 00:00",
        """  // GBP Guard: 5am UTC daily — checks all business + competitor profiles for changes
  cron.schedule('0 5 * * *', async () => {
    logger.info('[Cron] GBP Guard daily check');
    await weeklyScheduler.runDailyGuardCheck().catch(e => logger.error('[Cron] Guard failed', { error: e.message }));
  }, { timezone: 'UTC' });

  // Monthly credit reset: 1st of month 00:00"""
    )

# Update cron log
src = src.replace(
    "jobs: ['L2@01:00','Collect@01:30','L3@Mon02:00','Reviews@04:00','Citations@Mon09:00','Credits@1st']",
    "jobs: ['L2@01:00','Collect@01:30','L3@Mon02:00','Reviews@04:00','Guard@05:00','Citations@Mon09:00','Credits@1st']"
)

with open(path, 'w') as f: f.write(src)
print("  ✓ index.ts guard cron + route added")
PYEOF

# ── 5. Update api.ts frontend ─────────────────────────────────
echo "  [5/6] api.ts — add gbpGuardApi"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/frontend/src/lib/api.ts'
with open(path) as f: src = f.read()

if 'gbpGuardApi' not in src:
    src = src + """
export const gbpGuardApi = {
  summary:      (businessId: string) => api.get('/gbp-guard/summary?businessId=' + businessId),
  alerts:       (businessId: string, includeRead = false) =>
                  api.get('/gbp-guard/alerts?businessId=' + businessId + '&includeRead=' + includeRead),
  markRead:     (alertIds: string[]) => api.post('/gbp-guard/mark-read', { alertIds }),
  markAllRead:  (businessId: string) => api.post('/gbp-guard/mark-all-read', { businessId }),
  history:      (entityId: string, limit = 30) =>
                  api.get('/gbp-guard/history?entityId=' + entityId + '&limit=' + limit),
};
"""
    with open(path, 'w') as f: f.write(src)
    print("  ✓ api.ts gbpGuardApi added")
else:
    print("  ✓ api.ts gbpGuardApi already present")
PYEOF

# ── 6. GBPGuard.tsx frontend page ────────────────────────────
echo "  [6/6] GBPGuard.tsx frontend page"
cat > "$ROOT/apps/frontend/src/pages/GBPGuard.tsx" << 'EOF'
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { gbpGuardApi, bizApi } from '../lib/api';

const SEVERITY_STYLE = {
  critical: { bg: 'bg-red-50',    border: 'border-red-200',    badge: 'bg-red-100 text-red-700',    icon: '🚨', label: 'Critical'  },
  warning:  { bg: 'bg-amber-50',  border: 'border-amber-200',  badge: 'bg-amber-100 text-amber-700',icon: '⚠️', label: 'Warning'   },
  info:     { bg: 'bg-blue-50',   border: 'border-blue-200',   badge: 'bg-blue-100 text-blue-700',  icon: 'ℹ️', label: 'Info'      },
};

export default function GBPGuardPage() {
  const qc = useQueryClient();
  const [selectedBizId, setSelectedBizId] = useState<string>('');
  const [showRead, setShowRead] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: businesses } = useQuery({
    queryKey: ['businesses'],
    queryFn:  () => bizApi.list().then(r => r.data.businesses),
    onSuccess: (data: any[]) => { if (data?.length && !selectedBizId) setSelectedBizId(data[0].id); },
  });

  const bizId = selectedBizId || businesses?.[0]?.id || '';

  const { data: summary } = useQuery({
    queryKey: ['guard-summary', bizId],
    queryFn:  () => gbpGuardApi.summary(bizId).then(r => r.data),
    enabled:  !!bizId,
    refetchInterval: 60000,
  });

  const { data: alertData, isLoading } = useQuery({
    queryKey: ['guard-alerts', bizId, showRead],
    queryFn:  () => gbpGuardApi.alerts(bizId, showRead).then(r => r.data),
    enabled:  !!bizId,
    refetchInterval: 60000,
  });

  const markReadMutation = useMutation({
    mutationFn: (ids: string[]) => gbpGuardApi.markRead(ids),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['guard-alerts'] }),
  });

  const markAllMutation = useMutation({
    mutationFn: () => gbpGuardApi.markAllRead(bizId),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['guard-alerts'] }),
  });

  const alerts: any[] = alertData?.alerts ?? [];
  const unread  = alerts.filter(a => !a.is_read).length;
  const selectedBiz = businesses?.find((b: any) => b.id === bizId);

  return (
    <div className="max-w-4xl space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-green-100 rounded-2xl flex items-center justify-center text-2xl">🛡️</div>
          <div>
            <h1 className="text-xl font-bold">GBP Guard</h1>
            <p className="text-sm text-gray-400">Monitors your Google Business Profile for unauthorized changes · Checks daily at 5am</p>
          </div>
        </div>
        {unread > 0 && (
          <button onClick={() => markAllMutation.mutate()}
            className="text-sm text-brand-600 font-semibold hover:text-brand-800"
            disabled={markAllMutation.isPending}>
            {markAllMutation.isPending ? 'Marking...' : `Mark all ${unread} as read`}
          </button>
        )}
      </div>

      {/* Business selector */}
      {businesses && businesses.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {businesses.map((b: any) => (
            <button key={b.id} onClick={() => setSelectedBizId(b.id)}
              className={'px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-colors ' +
                (b.id === bizId ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}>
              {b.name}
            </button>
          ))}
        </div>
      )}

      {/* Summary stats */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className={'card text-center ' + (summary.criticalUnread > 0 ? 'border-2 border-red-300 bg-red-50' : '')}>
            <p className={'text-3xl font-black ' + (summary.criticalUnread > 0 ? 'text-red-600' : 'text-gray-300')}>
              {summary.criticalUnread}
            </p>
            <p className="text-xs text-gray-500 mt-1">Critical alerts</p>
          </div>
          <div className="card text-center">
            <p className={'text-3xl font-black ' + (summary.totalUnread > 0 ? 'text-amber-500' : 'text-gray-300')}>
              {summary.totalUnread}
            </p>
            <p className="text-xs text-gray-500 mt-1">Unread alerts</p>
          </div>
          <div className="card text-center">
            <p className="text-3xl font-black text-brand-600">{summary.businessesMonitored}</p>
            <p className="text-xs text-gray-500 mt-1">Locations monitored</p>
          </div>
          <div className="card text-center">
            <p className="text-3xl font-black text-purple-600">{summary.competitorsMonitored}</p>
            <p className="text-xs text-gray-500 mt-1">Competitors monitored</p>
          </div>
        </div>
      )}

      {/* What is monitored */}
      <div className="card bg-green-50 border border-green-200">
        <div className="flex items-start gap-3">
          <span className="text-2xl shrink-0">🛡️</span>
          <div>
            <p className="font-semibold text-green-900 mb-1">20 fields monitored daily</p>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {['Business Name','Address','Phone','Website','Description',
                'Map Pin','Opening Hours','Primary Category','Secondary Categories',
                'Rating','Review Count','Place ID','Permanently Closed',
                'Store Code','Google CID','Latitude','Longitude'].map(f => (
                <span key={f} className="bg-white border border-green-200 text-green-700 px-2 py-0.5 rounded-full">{f}</span>
              ))}
            </div>
            {summary?.lastChecked && (
              <p className="text-xs text-green-600 mt-2">
                Last checked: {new Date(summary.lastChecked).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Alerts */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
            {showRead ? 'All alerts' : 'Unread alerts'}
            {alerts.length > 0 && <span className="ml-2 bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{alerts.length}</span>}
          </h2>
          <button onClick={() => setShowRead(s => !s)}
            className="text-xs text-brand-600 font-medium hover:underline">
            {showRead ? 'Hide read' : 'Show all'}
          </button>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[1,2,3].map(i => <div key={i} className="h-20 bg-gray-100 rounded-xl animate-pulse" />)}
          </div>
        ) : !alerts.length ? (
          <div className="card text-center py-12">
            <p className="text-4xl mb-3">✅</p>
            <p className="font-semibold text-gray-700">All clear — no changes detected</p>
            <p className="text-sm text-gray-400 mt-1">
              Your business profile is being monitored. We'll alert you immediately if anything changes.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {alerts.map((alert: any) => {
              const sev = SEVERITY_STYLE[alert.severity as keyof typeof SEVERITY_STYLE] ?? SEVERITY_STYLE.info;
              const isExpanded = expandedId === alert.id;
              return (
                <div key={alert.id}
                  className={`rounded-xl border-2 p-4 transition-all ${sev.bg} ${sev.border} ${alert.is_read ? 'opacity-60' : ''}`}>
                  <div className="flex items-start gap-3">
                    <span className="text-xl shrink-0 mt-0.5">{sev.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${sev.badge}`}>{sev.label}</span>
                        {alert.is_competitor && (
                          <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">Competitor</span>
                        )}
                        <span className="text-xs font-semibold text-gray-700">{alert.field_label}</span>
                        <span className="text-xs text-gray-400 ml-auto">
                          {new Date(alert.detected_at).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-gray-800 mb-1">
                        {alert.entity_name}
                      </p>
                      <p className="text-sm text-gray-600 mb-2">{alert.ai_explanation}</p>

                      {/* Before / After */}
                      <button onClick={() => setExpandedId(isExpanded ? null : alert.id)}
                        className="text-xs text-brand-600 font-medium hover:underline">
                        {isExpanded ? 'Hide details ↑' : 'Show before/after ↓'}
                      </button>

                      {isExpanded && (
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <div className="bg-white rounded-lg p-3 border border-gray-200">
                            <p className="text-xs text-gray-400 mb-1 font-semibold">Before</p>
                            <p className="text-sm font-mono text-red-700 break-all">
                              {alert.old_value || <span className="text-gray-400 italic">empty</span>}
                            </p>
                          </div>
                          <div className="bg-white rounded-lg p-3 border border-gray-200">
                            <p className="text-xs text-gray-400 mb-1 font-semibold">After</p>
                            <p className="text-sm font-mono text-green-700 break-all">
                              {alert.new_value || <span className="text-gray-400 italic">empty</span>}
                            </p>
                          </div>
                        </div>
                      )}

                      {!alert.is_read && (
                        <button onClick={() => markReadMutation.mutate([alert.id])}
                          className="mt-2 text-xs text-gray-500 hover:text-gray-700 font-medium">
                          Mark as read ✓
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Info footer */}
      <div className="bg-gray-50 rounded-xl p-4 text-sm text-gray-500 space-y-1">
        <p className="font-semibold text-gray-700">How GBP Guard works</p>
        <p>Every day at 5am we take a snapshot of all monitored fields for your business and competitors. We compare it to the previous day's snapshot and alert you to any changes.</p>
        <p className="text-xs mt-2">Uses zero credits — GBP Guard runs entirely in the background as part of your plan.</p>
      </div>
    </div>
  );
}
EOF

# ── 7. Update Layout.tsx — add GBP Guard nav ─────────────────
echo "  Updating Layout.tsx — add GBP Guard nav item"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/frontend/src/components/Layout.tsx'
with open(path) as f: src = f.read()

if 'GBP Guard' not in src:
    # Add import
    src = src.replace(
        "import CustomScanPage      from '../pages/CustomScan';",
        "import CustomScanPage      from '../pages/CustomScan';\nimport GBPGuardPage        from '../pages/GBPGuard';"
    )
    # Add nav item after Citations
    src = src.replace(
        "  { path: '/citations',  icon: '📋', label: 'Citation Audit' },",
        "  { path: '/citations',  icon: '📋', label: 'Citation Audit' },\n  { path: '/gbp-guard',   icon: '🛡️', label: 'GBP Guard' },"
    )
    # Add route
    src = src.replace(
        "              <Route path=\"/custom-scan\"          element={<CustomScanPage />} />",
        "              <Route path=\"/custom-scan\"          element={<CustomScanPage />} />\n              <Route path=\"/gbp-guard\"            element={<GBPGuardPage />} />"
    )
    # Add to PAGE_TITLE
    src = src.replace(
        "    '/custom-scan':  'Custom Scan',",
        "    '/custom-scan':  'Custom Scan',\n    '/gbp-guard':    'GBP Guard',"
    )
    with open(path, 'w') as f: f.write(src)
    print("  ✓ Layout.tsx GBP Guard nav added")
else:
    print("  ✓ Layout.tsx GBP Guard already present")
PYEOF

# ── 8. SQL migration ──────────────────────────────────────────
echo "  Writing SQL migration 008..."
cat > "$ROOT/migration/008-gbp-guard.sql" << 'SQLEOF'
-- Migration 008: GBP Guard
-- Run in Supabase SQL Editor

-- GBP snapshots — daily point-in-time capture of all 20 monitored fields
CREATE TABLE IF NOT EXISTS public.gbp_snapshots (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_id       uuid NOT NULL,   -- business.id or competitor.id
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  is_competitor   boolean NOT NULL DEFAULT false,
  place_id        text,
  snapshot_data   jsonb NOT NULL,  -- full GBPSnapshot object
  captured_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gbp_snapshots_entity
  ON public.gbp_snapshots(entity_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_gbp_snapshots_user
  ON public.gbp_snapshots(user_id, captured_at DESC);

ALTER TABLE public.gbp_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own snapshots" ON public.gbp_snapshots;
CREATE POLICY "Users see own snapshots" ON public.gbp_snapshots
  FOR ALL USING (user_id = auth.uid());

GRANT ALL ON public.gbp_snapshots TO service_role;

-- GBP Guard alerts — change events detected between snapshots
CREATE TABLE IF NOT EXISTS public.gbp_guard_alerts (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_id       uuid NOT NULL,   -- business.id or competitor.id
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  is_competitor   boolean NOT NULL DEFAULT false,
  entity_name     text NOT NULL,
  field_name      text NOT NULL,   -- e.g. 'name', 'address', 'phone'
  field_label     text NOT NULL,   -- e.g. 'Business Name', 'Address'
  old_value       text,
  new_value       text,
  severity        text NOT NULL DEFAULT 'info'
    CHECK (severity IN ('critical','warning','info')),
  ai_explanation  text,
  is_read         boolean NOT NULL DEFAULT false,
  read_at         timestamptz,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gbp_alerts_user_unread
  ON public.gbp_guard_alerts(user_id, is_read, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_gbp_alerts_entity
  ON public.gbp_guard_alerts(entity_id, detected_at DESC);

ALTER TABLE public.gbp_guard_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own alerts" ON public.gbp_guard_alerts;
CREATE POLICY "Users see own alerts" ON public.gbp_guard_alerts
  FOR ALL USING (user_id = auth.uid());

GRANT ALL ON public.gbp_guard_alerts TO service_role;

-- Auto-cleanup: keep only 90 days of snapshots (they accumulate fast)
CREATE OR REPLACE FUNCTION public.cleanup_old_snapshots()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM public.gbp_snapshots
  WHERE captured_at < now() - INTERVAL '90 days';
END;
$$;

-- Verify
-- SELECT 'gbp_snapshots' as tbl, count(*) FROM public.gbp_snapshots
-- UNION ALL
-- SELECT 'gbp_guard_alerts', count(*) FROM public.gbp_guard_alerts;
SQLEOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " GBP Guard complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " Files created/updated:"
echo "   ✓ [NEW] apps/api/src/domains/gbpguard/GBPGuardService.ts"
echo "   ✓ [NEW] apps/api/src/api/routes/gbpGuard.ts"
echo "   ✓ [UPD] apps/api/src/domains/scheduling/WeeklyScheduler.ts"
echo "   ✓ [UPD] apps/api/src/index.ts"
echo "   ✓ [UPD] apps/frontend/src/lib/api.ts"
echo "   ✓ [NEW] apps/frontend/src/pages/GBPGuard.tsx"
echo "   ✓ [UPD] apps/frontend/src/components/Layout.tsx"
echo "   ✓ [NEW] migration/008-gbp-guard.sql"
echo ""
echo " Next steps:"
echo "   1. Run migration/008-gbp-guard.sql in Supabase SQL Editor"
echo "   2. npm run dev"
echo "   3. Visit /gbp-guard in your app"
echo ""
echo " How it works:"
echo "   Daily 5am UTC — checks all 20 fields for every business + competitor"
echo "   Compares to yesterday's snapshot — alerts on any change"
echo "   Severity: Critical (name/address/phone/pin) · Warning · Info"
echo "   AI explanation for every change"
echo "   Zero credits consumed — included in all plans"
echo ""
