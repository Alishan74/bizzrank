# BizzRank RBAC route enforcement — installation

This is the SECOND layer of RBAC. It updates all 7 existing route files to
enforce the permissions you set up in the foundation layer.

Prerequisites:
  - bizzrank-rbac-foundation.zip already installed and SQL migration run
  - /api/orgs endpoint working correctly

## What gets updated

Each file replaces the existing one at the same path:

  apps/api/src/api/routes/businesses.ts
  apps/api/src/api/routes/organicScans.ts
  apps/api/src/api/routes/adScans.ts
  apps/api/src/api/routes/competitors.ts
  apps/api/src/api/routes/reviews.ts
  apps/api/src/api/routes/leaderboard.ts
  apps/api/src/api/routes/dashboard.ts
  apps/api/src/api/routes/citations.ts

profile.ts is unchanged (profile is per-user, not per-org).
auth.ts is unchanged from the foundation layer (already updated there).

## What the changes do

Every route now:
  1. Uses `loadOrgContext` middleware → loads req.orgContext per request
  2. Filters list endpoints by org_id (and assigned business IDs for non-owners)
  3. Calls `permissionService.canActOnBusiness()` before mutations
  4. Returns 403 with a clear message when access is denied
  5. Creates new records with org_id set + auto-grants creator access

Result: a manager can only see/edit the businesses you've assigned to them.
A viewer can see assigned businesses but can't run scans or edit anything.
Owners see everything in their org.

## Apply

In Codespaces:

    cd /workspaces/bizzrank/bizzrank-v10
    # drop the zip in via file-tree drag-and-drop OR upload, then:
    unzip -o bizzrank-rbac-routes.zip

Restart the API. In the npm run dev terminal:
    Ctrl+C
    npm run dev

Watch for clean startup with all workers running.

## Smoke test as the OWNER (you)

Refresh BizzRank in your browser. As owner, EVERYTHING should still work
the same as before — you see all businesses, all scans, all reviews.

If anything that worked yesterday is broken today, something is wrong with
my route updates. Paste the error and we'll fix it.

## Smoke test as a MANAGER (the real test)

This is where the RBAC payoff shows. Steps:

  1. Open Postman or use curl.
  2. Use POST /api/orgs/invitations to invite yourself at a SECOND email
     (or a friend) with role = "manager".
  3. Sign up that email via /api/auth/accept-invite-signup.
  4. Sign in as that user. Their /api/auth/me should return
     currentRole = "manager".
  5. Hit /api/businesses — should return EMPTY array (no businesses assigned).
  6. As the OWNER, POST /api/orgs/businesses/<biz-id>/assign with that user's userId.
  7. Hit /api/businesses again as the manager — now the one assigned business
     appears. No others.

That confirms permission enforcement is working end-to-end.

## Behavior summary by role

  OWNER          — sees all businesses, all scans, all reviews; can do everything
  BILLING_ADMIN  — sees all businesses (read-only); manages billing only
  MANAGER        — sees ONLY assigned businesses; can run scans + edit those businesses
  VIEWER         — sees ONLY assigned businesses; read-only, can't run scans

## Rollback

If you need to revert these changes only (keeping foundation intact),
re-extract bizzrank-v10-fixes.zip or your previous version. The old route
files still work — they just don't enforce permissions.
