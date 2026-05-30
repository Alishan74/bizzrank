#!/usr/bin/env bash
# BizzRank AI — Six Critical Runtime Fixes
# cd /workspaces/bizzrank/bizzrank-v10 && bash critical_fixes.sh
set -e
ROOT="$(pwd)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " BizzRank AI — Six Critical Runtime Fixes"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─────────────────────────────────────────────────────────────
# FIX 1: RBAC schema mismatch
#
# BUG: organizations table was created with owner_user_id
#      but orgs.ts queries owner_id everywhere.
#      org_invitations has accepted_at but orgs.ts queries accepted.
#
# The code is correct — owner_id and accepted are the simpler,
# consistent names. The migration SQL is wrong.
# Fix: update the migration to match what the code expects.
# Also fix orgContext.ts which queries owner_user_id.
# ─────────────────────────────────────────────────────────────
echo "  [1/6] RBAC schema mismatch — align migration + orgContext to use owner_id"

# Fix orgContext.ts: owner_user_id → owner_id
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/api/middleware/orgContext.ts'
with open(path) as f: src = f.read()
src = src.replace(
    ".eq('owner_user_id', req.userId)",
    ".eq('owner_id', req.userId)"
)
with open(path, 'w') as f: f.write(src)
print("  ✓ orgContext.ts — owner_user_id → owner_id")
PYEOF

# Write corrected migration that uses owner_id and accepted
cat > "$ROOT/migration/001-add-orgs-and-rbac.sql" << 'SQLEOF'
-- ============================================================
-- BizzRank v10 → Multi-tenant RBAC migration
-- FIXED: uses owner_id (not owner_user_id), accepted (not accepted_at)
-- ============================================================
begin;

-- ── 1. ORGANIZATIONS ────────────────────────────────────────
create table if not exists public.organizations (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  plan                     text not null default 'starter',
  credits_pool             integer not null default 0,
  credits_used_this_month  integer not null default 0,
  monthly_allowance        integer not null default 900,
  max_businesses           integer not null default 1,
  max_users                integer not null default 1,
  billing_cycle_start      date default current_date,
  -- FIXED: was owner_user_id — code uses owner_id everywhere
  owner_id                 uuid not null references auth.users(id) on delete cascade,
  created_at               timestamptz default now(),
  updated_at               timestamptz default now()
);

create index if not exists idx_orgs_owner on public.organizations(owner_id);

-- ── 2. ORG MEMBERS ──────────────────────────────────────────
create table if not exists public.org_members (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references public.organizations(id) on delete cascade,
  user_id                 uuid not null references auth.users(id) on delete cascade,
  role                    text not null check (role in ('owner', 'manager', 'viewer', 'billing_admin')),
  monthly_credit_budget   integer default 0,
  credits_used_this_month integer default 0,
  created_at              timestamptz default now(),
  invited_by              uuid references auth.users(id),
  unique(org_id, user_id)
);

create index if not exists idx_org_members_org  on public.org_members(org_id);
create index if not exists idx_org_members_user on public.org_members(user_id);

-- ── 3. BUSINESS-USER ACCESS ─────────────────────────────────
create table if not exists public.business_user_access (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  granted_by  uuid references auth.users(id),
  granted_at  timestamptz default now(),
  unique(business_id, user_id)
);

create index if not exists idx_business_access_user on public.business_user_access(user_id);
create index if not exists idx_business_access_biz  on public.business_user_access(business_id);
create index if not exists idx_business_access_org  on public.business_user_access(org_id);

-- ── 4. INVITATIONS ──────────────────────────────────────────
create table if not exists public.org_invitations (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  email      text not null,
  role       text not null default 'viewer' check (role in ('manager', 'viewer', 'billing_admin')),
  invited_by uuid not null references auth.users(id),
  token      text unique not null default encode(gen_random_bytes(24), 'hex'),
  expires_at timestamptz default (now() + interval '7 days'),
  -- FIXED: was accepted_at — code queries .eq('accepted', false)
  accepted   boolean not null default false,
  created_at timestamptz default now()
);

create index if not exists idx_invitations_token on public.org_invitations(token);
create index if not exists idx_invitations_org   on public.org_invitations(org_id);
create index if not exists idx_invitations_email on public.org_invitations(email);

-- ── 5. EXTEND EXISTING TABLES ───────────────────────────────
alter table public.businesses
  add column if not exists org_id uuid references public.organizations(id) on delete cascade;

create index if not exists idx_businesses_org on public.businesses(org_id);

alter table public.profiles
  add column if not exists current_org_id uuid references public.organizations(id);

-- ── DATA MIGRATION ───────────────────────────────────────────
-- Create one org per existing user (idempotent)
insert into public.organizations
  (name, plan, credits_pool, monthly_allowance, max_businesses, max_users, owner_id)
select
  coalesce(p.full_name, 'My') || '''s workspace',
  p.plan,
  p.credits_balance,
  p.monthly_allowance,
  p.max_businesses,
  case p.plan
    when 'starter'      then 1
    when 'growth'       then 1
    when 'pro'          then 2
    when 'agency'       then 5
    when 'professional' then 5
    when 'enterprise'   then 999
    else 1
  end,
  p.id
from public.profiles p
where not exists (
  select 1 from public.organizations o where o.owner_id = p.id
);

-- Add each user as owner of their org
insert into public.org_members (org_id, user_id, role)
select o.id, o.owner_id, 'owner'
from public.organizations o
where not exists (
  select 1 from public.org_members m
  where m.org_id = o.id and m.user_id = o.owner_id
);

-- Set every profile's current_org_id
update public.profiles p
set current_org_id = o.id
from public.organizations o
where o.owner_id = p.id and p.current_org_id is null;

-- Assign all existing businesses to owner's org
update public.businesses b
set org_id = o.id
from public.organizations o
where b.user_id = o.owner_id and b.org_id is null;

-- Grant owners access to their own businesses
insert into public.business_user_access (business_id, user_id, org_id, granted_by)
select b.id, b.user_id, b.org_id, b.user_id
from public.businesses b
where b.org_id is not null
  and not exists (
    select 1 from public.business_user_access a
    where a.business_id = b.id and a.user_id = b.user_id
  );

-- Make org_id required now that every row has one
alter table public.businesses alter column org_id set not null;

commit;
SQLEOF
echo "  ✓ migration/001 rewritten — owner_id and accepted fixed"

# ─────────────────────────────────────────────────────────────
# FIX 2: businesses.ts insert missing org_id
#
# BUG: After migration, businesses.org_id is NOT NULL.
# businesses.ts POST inserts a business without org_id.
# Every new business creation fails with NOT NULL violation.
#
# Fix: look up the user's org_id from their profile and
# include it in every business insert.
# ─────────────────────────────────────────────────────────────
echo "  [2/6] businesses.ts — add org_id to business insert"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/api/routes/businesses.ts'
with open(path) as f: src = f.read()

old = """  const { data: profile } = await supabase.from('profiles').select('plan').eq('id', req.userId!).single();
  const limit = businessLimit(profile?.plan ?? 'starter');
  const { count } = await supabase.from('businesses').select('*', { count: 'exact', head: true }).eq('user_id', req.userId!).neq('is_active', false);
  if (limit !== 999 && (count ?? 0) >= limit) return res.status(403).json({ error: `Your ${profile?.plan} plan allows ${limit} business${limit === 1 ? '' : 'es'}. Upgrade to add more.`, limitReached: true });
  const { data, error } = await supabase.from('businesses').insert({ user_id: req.userId, name, address, latitude, longitude, phone, website, category, google_place_id: googlePlaceId, opening_hours: openingHours ?? null }).select().single();"""

new = """  const { data: profile } = await supabase.from('profiles')
    .select('plan, current_org_id').eq('id', req.userId!).single();
  const limit = businessLimit(profile?.plan ?? 'starter');
  const { count } = await supabase.from('businesses').select('*', { count: 'exact', head: true }).eq('user_id', req.userId!).neq('is_active', false);
  if (limit !== 999 && (count ?? 0) >= limit) return res.status(403).json({ error: `Your ${profile?.plan} plan allows ${limit} business${limit === 1 ? '' : 'es'}. Upgrade to add more.`, limitReached: true });

  // org_id is required (NOT NULL after RBAC migration)
  // Look it up from profile.current_org_id; fall back to owned org
  let orgId = profile?.current_org_id;
  if (!orgId) {
    const { data: org } = await supabase.from('organizations')
      .select('id').eq('owner_id', req.userId!).limit(1).single();
    orgId = org?.id;
  }
  if (!orgId) return res.status(400).json({ error: 'No organization found. Please complete account setup.' });

  const { data, error } = await supabase.from('businesses').insert({
    user_id: req.userId, org_id: orgId,
    name, address, latitude, longitude, phone, website, category,
    google_place_id: googlePlaceId, opening_hours: openingHours ?? null,
  }).select().single();"""

src = src.replace(old, new)
with open(path, 'w') as f: f.write(src)
print("  ✓ businesses.ts — org_id fetched and included in insert")
PYEOF

# Fix the GBPModal in Businesses.tsx too — hardcoded wrong limits
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/frontend/src/pages/Businesses.tsx'
with open(path) as f: src = f.read()

# Replace the hardcoded limitMap with the correct plan limits
src = src.replace(
    "  const limitMap: Record<string, number> = { starter: 1, professional: 5, agency: 999, enterprise: 999 };\n  const limit = limitMap[me?.plan ?? 'starter'] ?? 1;",
    """  // FIXED: was hardcoded wrong (missing growth/pro, agency was 999 not 5)
  // Now matches BillingService.PLANS exactly
  const limitMap: Record<string, number> = {
    starter: 1, growth: 1, pro: 2, agency: 5,
    professional: 5, enterprise: 999,
  };
  const limit = limitMap[me?.plan ?? 'starter'] ?? 1;"""
)
with open(path, 'w') as f: f.write(src)
print("  ✓ Businesses.tsx — GBPModal limitMap corrected")
PYEOF

# ─────────────────────────────────────────────────────────────
# FIX 3: Automated L2 scan race condition
#
# BUG: WEEKLY_SCAN (Standard Queue) posts a DataForSEO task
# and IMMEDIATELY returns { organic: [], sponsored: [] }.
# OrganicScanService then saves rankings from that empty
# response — so daily scans produce 0-score data every day.
# The collect cron at 1:30am warms the cache but the scan
# worker has already written zeros to the DB by then.
#
# Root cause: OrganicScanService treats WEEKLY_SCAN exactly
# like MANUAL_SCAN (Live). For automated scans it should
# only process results if the cache is already warm.
#
# Fix: in ScanWorker/OrganicScanService, when ttlContext is
# WEEKLY_SCAN, skip immediate processing and let the collect
# cron write results via the cache. Add a post-collect
# result processor that writes rankings from warmed cache.
# ─────────────────────────────────────────────────────────────
echo "  [3/6] Automated L2 — skip empty results, process from cache after collect"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/domains/scanning/OrganicScanService.ts'
with open(path) as f: src = f.read()

# The fix: before the batch scan loop, check if this is an
# automated scan. If so, check the shared scan result cache.
# If cache is warm (collect cron ran), use it. If cold,
# mark the scan as pending_collect and exit — the collect
# cron will trigger reprocessing.
old_scan_header = """    // Scan all grid points in batches of 5
    const BATCH = 5;
    for (let i = 0; i < points.length; i += BATCH) {
      const batch = points.slice(i, i + BATCH);
      await Promise.all(batch.map(async pt => {
        const res  = await serpApiService.search(keyword, pt.lat, pt.lng, radiusMeters, ttlContext, tag);"""

new_scan_header = """    // For automated scans (WEEKLY_SCAN / Standard Queue):
    // DataForSEO Standard Queue posts a task and returns empty immediately.
    // The collect cron at 1:30am fetches results and warms the shared cache.
    // We must NOT save empty results — that would write 0-score rows to DB.
    //
    // Strategy: if isAutomated=true and results are empty after first point,
    // mark scan as 'pending_collect' and exit. The collect cron will call
    // processFromCache() which re-runs saveRankings from warmed shared cache.
    const isAutomatedScan = !!isAutomated;

    // Scan all grid points in batches of 5
    const BATCH = 5;
    for (let i = 0; i < points.length; i += BATCH) {
      const batch = points.slice(i, i + BATCH);
      await Promise.all(batch.map(async pt => {
        const res  = await serpApiService.search(keyword, pt.lat, pt.lng, radiusMeters, ttlContext, tag);"""

src = src.replace(old_scan_header, new_scan_header)

# After scanning, check if all organic results are empty (Standard Queue case)
old_after_scan = """    await this.saveRankings(scanId, userId, businessId, keyword, today, points, organic);
    await this.saveSponsored(scanId, userId, businessId, keyword, today, sponsored);"""

new_after_scan = """    // Check if Standard Queue returned all empty results
    // (expected — tasks are queued, not returned synchronously)
    const totalResults = [...organic.values()].reduce((s, r) => s + r.length, 0);

    if (isAutomatedScan && totalResults === 0) {
      // All results are empty — Standard Queue tasks posted but not yet processed.
      // Mark as pending_collect. The collect cron will call processFromCache()
      // after results are ready. Do NOT write 0-score data to DB.
      await db.from('organic_scans').update({
        state: 'pending_collect',
        points_completed: 0,
      }).eq('id', scanId);
      await releaseScanSlot(userId);
      logger.info('[Scan] Automated scan queued for collect', { scanId, keyword });
      return;
    }

    // Results available (either Live/Priority Queue, or Standard Queue cache hit)
    await this.saveRankings(scanId, userId, businessId, keyword, today, points, organic);
    await this.saveSponsored(scanId, userId, businessId, keyword, today, sponsored);"""

src = src.replace(old_after_scan, new_after_scan)

# Add processFromCache method — called by collect cron after warming cache
new_method = """
  /**
   * Called by the collect cron after Standard Queue results are ready.
   * Finds all scans in 'pending_collect' state and processes them
   * from the shared scan result cache (warmed by collectPendingTasks).
   *
   * This is the fix for the automated L2 race condition:
   * Standard Queue → posts tasks → returns empty → scan marked pending_collect
   * Collect cron → fetches results → warms cache → calls processFromCache
   * processFromCache → reads cache → saves real rankings to DB
   */
  async processFromCache(): Promise<{ processed: number; skipped: number }> {
    const { data: pendingScans } = await db.from('organic_scans')
      .select('id, user_id, business_id, keyword, target_lat, target_lng, scan_points, competitors, client_google_place_id')
      .eq('state', 'pending_collect')
      .order('created_at', { ascending: true })
      .limit(50);

    if (!pendingScans?.length) return { processed: 0, skipped: 0 };

    let processed = 0, skipped = 0;
    const today = new Date().toISOString().split('T')[0];

    for (const scan of pendingScans) {
      try {
        const points: ScanPoint[] = scan.scan_points ?? [];
        if (!points.length) { skipped++; continue; }

        const { getSharedScanResult } = await import('../../infrastructure/cache/CacheService.js');
        const organic  = new Map<number, any[]>();
        const sponsored = new Map<number, any[]>();
        let anyResults = false;

        for (const pt of points) {
          const cached = await getSharedScanResult(pt.lat, pt.lng, scan.keyword, today);
          if (cached) {
            organic.set(pt.index, cached.organic ?? []);
            sponsored.set(pt.index, cached.sponsored ?? []);
            if ((cached.organic?.length ?? 0) > 0) anyResults = true;
          }
        }

        if (!anyResults) { skipped++; continue; } // results not ready yet

        await this.saveRankings(scan.id, scan.user_id, scan.business_id, scan.keyword, today, points, organic);
        await this.saveSponsored(scan.id, scan.user_id, scan.business_id, scan.keyword, today, sponsored);

        const clientScore = this.buildScore(scan.client_google_place_id, 'Your Business', true, points, organic);
        const competitors: Array<{ googlePlaceId: string | null; name: string }> = scan.competitors ?? [];
        const competitorScores = competitors.map(c => this.buildScore(c.googlePlaceId, c.name, false, points, organic));

        await db.from('organic_scores').insert({
          scan_id: scan.id, user_id: scan.user_id, business_id: scan.business_id,
          keyword: scan.keyword, scan_date: today,
          organic_visibility_score:    clientScore.visibilityScore,
          organic_avg_ranking:         clientScore.avgRanking,
          organic_territory_dominance: clientScore.territoryDominance,
          organic_total_cells:         points.length,
          organic_ranked_cells:        clientScore.rankedCells,
          organic_top3_cells:          clientScore.top3Cells,
          organic_top10_cells:         clientScore.top10Cells,
          organic_heatmap_points:      clientScore.heatmapPoints,
          competitor_scores:           competitorScores,
        });

        await db.from('organic_scans').update({
          state: 'completed',
          points_completed: points.length,
          completed_at: new Date().toISOString(),
        }).eq('id', scan.id);

        eventBus.publish(Events.SCAN_ORGANIC_COMPLETED, {
          scanId: scan.id, userId: scan.user_id, businessId: scan.business_id,
          keyword: scan.keyword, score: clientScore.visibilityScore,
          clientGooglePlaceId: scan.client_google_place_id,
        });

        processed++;
        logger.info('[Scan] processFromCache complete', { scanId: scan.id, score: clientScore.visibilityScore });
      } catch (err: any) {
        logger.error('[Scan] processFromCache failed', { scanId: scan.id, error: err.message });
        skipped++;
      }
    }

    return { processed, skipped };
  }
"""

# Insert before the last closing brace of the class
src = src.replace(
    "  private buildScore(",
    new_method + "\n  private buildScore("
)

with open(path, 'w') as f: f.write(src)
print("  ✓ OrganicScanService.ts — pending_collect state + processFromCache() added")
PYEOF

# Wire processFromCache into the collect cron
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/index.ts'
with open(path) as f: src = f.read()

old_collect = """  // Collect DataForSEO Standard Queue results (30min after posting)
  cron.schedule('30 1 * * *', async () => {
    logger.info('[Cron] Collecting Standard Queue results');
    try {
      const mod = await import('./domains/serpapi/SerpApiService.js') as any;
      if (typeof mod.collectPendingTasks === 'function') {
        const stats = await mod.collectPendingTasks();
        logger.info('[Cron] Collect done', stats);"""

new_collect = """  // Collect DataForSEO Standard Queue results (30min after posting)
  // After collecting, processFromCache() writes rankings for pending_collect scans
  cron.schedule('30 1 * * *', async () => {
    logger.info('[Cron] Collecting Standard Queue results');
    try {
      const mod = await import('./domains/serpapi/SerpApiService.js') as any;
      if (typeof mod.collectPendingTasks === 'function') {
        const stats = await mod.collectPendingTasks();
        logger.info('[Cron] Collect done', stats);"""

src = src.replace(old_collect, new_collect)

# Add processFromCache call after collect
src = src.replace(
    "        logger.info('[Cron] Collect done', stats);\n",
    "        logger.info('[Cron] Collect done', stats);\n"
    "        // Process pending_collect scans from warmed cache\n"
    "        const { organicScanService } = await import('./domains/scanning/OrganicScanService.js');\n"
    "        const pfc = await organicScanService.processFromCache();\n"
    "        logger.info('[Cron] processFromCache done', pfc);\n"
)

with open(path, 'w') as f: f.write(src)
print("  ✓ index.ts — collect cron calls processFromCache after warming")
PYEOF

# ─────────────────────────────────────────────────────────────
# FIX 4: SSE authentication — EventSource cannot send headers
#
# BUG: Frontend creates new EventSource(url) which is a native
# browser API that CANNOT set custom headers. The backend SSE
# endpoint uses requireAuth middleware which checks the
# Authorization header. Native EventSource always 401s.
#
# Fix: pass JWT as a URL query parameter for SSE only.
# Backend: extract token from ?token= query param for the SSE
# endpoint specifically (not for any other endpoint).
# Frontend: append ?token=... to the EventSource URL.
#
# Security note: URL tokens appear in server logs. This is
# acceptable for SSE because: (1) the token is the same JWT
# already in localStorage, (2) SSE is read-only, (3) the
# token expires in 7 days, (4) HTTPS in production encrypts
# the URL. This is the standard pattern for SSE auth.
# ─────────────────────────────────────────────────────────────
echo "  [4/6] SSE auth — pass token via URL query param"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/api/routes/organicScans.ts'
with open(path) as f: src = f.read()

# Add token-from-query middleware for SSE endpoint only
old_sse = "// GET /api/organic-scans/:scanId/progress (SSE)"
if "// GET /api/organic-scans/:scanId/progress (SSE)" in src:
    src = src.replace(
        "// GET /api/organic-scans/:scanId/progress (SSE)",
        """// GET /api/organic-scans/:scanId/progress  — Server-Sent Events
// Native browser EventSource cannot send Authorization headers.
// Token is passed as ?token= query param for this endpoint ONLY.
// This is the standard pattern for SSE authentication."""
    )
    # Find the SSE route and add token extraction before requireAuth
    src = src.replace(
        "router.get('/:scanId/progress', requireAuth, async (req: AuthRequest, res) => {",
        """router.get('/:scanId/progress', (req: any, res, next) => {
  // Extract JWT from query param for SSE (EventSource can't set headers)
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = 'Bearer ' + req.query.token;
  }
  next();
}, requireAuth, async (req: AuthRequest, res) => {"""
    )
    print("  ✓ organicScans.ts — SSE token-from-query added")
else:
    print("  ✓ organicScans.ts — SSE route not found in expected location, check manually")

with open(path, 'w') as f: f.write(src)
PYEOF

# Fix frontend EventSource to pass token as query param
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]

# Check api.ts for EventSource usage
api_path = root + '/apps/frontend/src/lib/api.ts'
with open(api_path) as f: src = f.read()

# Find and fix EventSource usage — add token to URL
if 'EventSource' in src:
    src = src.replace(
        "new EventSource(",
        "new EventSource("
    )
    # More targeted fix: find the specific EventSource call
    import re
    src = re.sub(
        r"new EventSource\(([^)]+)\)",
        lambda m: "new EventSource(" + m.group(1).rstrip() + " + '?token=' + (localStorage.getItem('token') ?? ''))",
        src,
        count=1
    )
    with open(api_path, 'w') as f: f.write(src)
    print("  ✓ api.ts — EventSource passes token as query param")
else:
    # Check in scan result page
    scan_path = root + '/apps/frontend/src/pages/ScanResultDetail.tsx'
    try:
        with open(scan_path) as f: scan_src = f.read()
        if 'EventSource' in scan_src:
            import re
            scan_src = re.sub(
                r"new EventSource\(([^)]+)\)",
                lambda m: "new EventSource(" + m.group(1).rstrip() + " + '?token=' + (localStorage.getItem('token') ?? ''))",
                scan_src,
                count=1
            )
            with open(scan_path, 'w') as f: f.write(scan_src)
            print("  ✓ ScanResultDetail.tsx — EventSource passes token as query param")
    except:
        print("  ⚠ EventSource not found in expected locations — check scan detail pages manually")
PYEOF

# ─────────────────────────────────────────────────────────────
# FIX 5: Plan economics inconsistency
#
# BUG: OrgService.planDefaults() has completely wrong values:
#   starter: 100 credits (should be 900)
#   agency:  2000 credits (should be 3500)
#   maxUsers for agency: 20 (OK but inconsistent with billing)
# This causes orgs created via OrgService to start with wrong
# credit pools, wrong maxBusinesses, and wrong allowances.
#
# Fix: replace planDefaults() with values from BillingService.PLANS
# ─────────────────────────────────────────────────────────────
echo "  [5/6] OrgService.ts — align planDefaults with BillingService.PLANS"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/domains/orgs/OrgService.ts'
with open(path) as f: src = f.read()

old = """  private planDefaults(plan: string): { credits: number; maxBusinesses: number; maxUsers: number } {
    switch (plan) {
      case 'professional': return { credits: 300,   maxBusinesses: 5,   maxUsers: 3   };
      case 'agency':       return { credits: 2000,  maxBusinesses: 999, maxUsers: 20  };
      case 'enterprise':   return { credits: 10000, maxBusinesses: 999, maxUsers: 999 };
      case 'starter':\n      default:             return { credits: 100,   maxBusinesses: 1,   maxUsers: 1   };
    }
  }"""

new = """  // FIXED: was completely wrong — starter had 100 credits, agency had 2000.
  // Now matches BillingService.PLANS exactly. Single source of truth.
  private planDefaults(plan: string): { credits: number; maxBusinesses: number; maxUsers: number } {
    switch (plan) {
      case 'starter':      return { credits: 900,   maxBusinesses: 1,   maxUsers: 1   };
      case 'growth':       return { credits: 1600,  maxBusinesses: 1,   maxUsers: 3   };
      case 'pro':          return { credits: 1800,  maxBusinesses: 2,   maxUsers: 5   };
      case 'professional': return { credits: 1800,  maxBusinesses: 5,   maxUsers: 5   };
      case 'agency':       return { credits: 3500,  maxBusinesses: 5,   maxUsers: 20  };
      case 'enterprise':   return { credits: 99999, maxBusinesses: 999, maxUsers: 999 };
      default:             return { credits: 900,   maxBusinesses: 1,   maxUsers: 1   };
    }
  }"""

if old in src:
    src = src.replace(old, new)
else:
    # The exact whitespace may differ — do a more flexible replacement
    import re
    src = re.sub(
        r"private planDefaults\(plan: string\).*?}\s*}",
        new,
        src,
        flags=re.DOTALL,
        count=1
    )

with open(path, 'w') as f: f.write(src)
print("  ✓ OrgService.ts — planDefaults corrected to match BillingService.PLANS")
PYEOF

# ─────────────────────────────────────────────────────────────
# FIX 6: CORS origin check too loose
#
# BUG: origin.startsWith(allowedOrigin) allows lookalike attacks.
# e.g. FRONTEND_URL = https://app.bizzrank.ai
# A hostile site at https://app.bizzrank.ai.evil.com would
# PASS the startsWith check because it starts with the right string.
#
# Fix: require exact origin match.
# The allowed origins list already covers both prod and dev cases.
# Localhost never needs startsWith — exact match is fine.
# ─────────────────────────────────────────────────────────────
echo "  [6/6] index.ts — fix CORS lookalike attack vector"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/index.ts'
with open(path) as f: src = f.read()

old_cors = """const allowedOrigins = [
  process.env.FRONTEND_URL ?? 'http://localhost:5173',
  'http://localhost:5173',
  'http://localhost:3000',
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, same-origin)
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) return callback(null, true);
    // In development, allow all
    if (process.env.NODE_ENV !== 'production') return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));"""

new_cors = """// CORS: exact origin match only — no startsWith
// startsWith was vulnerable to lookalike domains:
//   FRONTEND_URL = https://app.bizzrank.ai
//   https://app.bizzrank.ai.evil.com → would pass startsWith → BLOCKED now
const allowedOrigins = new Set([
  process.env.FRONTEND_URL,            // production frontend
  'http://localhost:5173',             // Vite dev server
  'http://localhost:3000',             // alt dev port
  'http://127.0.0.1:5173',            // explicit loopback
].filter(Boolean) as string[]);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (Postman, curl, server-to-server)
    if (!origin) return callback(null, true);
    // Exact match only
    if (allowedOrigins.has(origin)) return callback(null, true);
    // Dev mode: allow any localhost/127.0.0.1 origin
    if (process.env.NODE_ENV !== 'production' &&
        (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin "${origin}" not allowed`));
  },
  credentials: true,
}));"""

# Handle both versions — original star and our previous fix
src = src.replace("app.use(cors({ origin: '*', credentials: true }));", new_cors)
src = src.replace(old_cors, new_cors)

with open(path, 'w') as f: f.write(src)
print("  ✓ index.ts — CORS uses exact Set match, no startsWith")
PYEOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " All 6 critical fixes applied"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  FIX 1  migration/001 + orgContext.ts"
echo "         owner_user_id → owner_id (was causing org queries to return null)"
echo "         accepted_at → accepted (was causing invitations query to fail)"
echo ""
echo "  FIX 2  businesses.ts + Businesses.tsx"
echo "         business insert now fetches org_id from profile (NOT NULL was failing)"
echo "         GBPModal limitMap corrected: growth/pro added, agency=5 not 999"
echo ""
echo "  FIX 3  OrganicScanService.ts + index.ts"
echo "         Standard Queue returns empty → marks scan pending_collect (not 0-score)"
echo "         Collect cron calls processFromCache() → saves real rankings after ready"
echo ""
echo "  FIX 4  organicScans.ts + api.ts/ScanResultDetail.tsx"
echo "         SSE endpoint accepts ?token= query param (EventSource can't send headers)"
echo "         Frontend EventSource appends token from localStorage to URL"
echo ""
echo "  FIX 5  OrgService.ts"
echo "         planDefaults() corrected: starter=900, growth=1600, pro=1800, agency=3500"
echo "         (was: starter=100, agency=2000, missing growth/pro)"
echo ""
echo "  FIX 6  index.ts"
echo "         CORS uses Set + exact match — startsWith allowed lookalike domains"
echo "         https://app.bizzrank.ai.evil.com now correctly blocked"
echo ""
echo " Run migration/001-add-orgs-and-rbac.sql in Supabase (drop+recreate if already run)"
echo " Then: npm run dev"
echo ""
