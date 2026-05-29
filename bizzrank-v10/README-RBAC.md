# BizzRank RBAC foundation — installation guide

This is the **foundation layer** for multi-tenant role-based access control:
organizations, members, invitations, business assignments, and per-user
credit budgets. It DOES NOT yet enforce these permissions on existing
routes (businesses, scans, reviews, etc.) — that's the next delivery.
This layer adds the data model, services, and management endpoints so
you can start creating orgs and inviting users right away.

## What you get in this drop

| File | Path | Purpose |
|------|------|---------|
| migration/001-add-orgs-and-rbac.sql | (run in Supabase SQL Editor) | Creates 4 new tables, adds 2 columns, migrates existing data |
| shared/types/rbac.ts | apps/api/src/shared/types/rbac.ts | Shared TypeScript types |
| domains/orgs/OrgService.ts | apps/api/src/domains/orgs/OrgService.ts | Org lifecycle + member/invite logic |
| domains/orgs/PermissionService.ts | apps/api/src/domains/orgs/PermissionService.ts | Pure boolean permission checks |
| api/middleware/orgContext.ts | apps/api/src/api/middleware/orgContext.ts | Loads org context per request |
| api/routes/orgs.ts | apps/api/src/api/routes/orgs.ts | /api/orgs/* endpoints |
| api/routes/auth.ts | apps/api/src/api/routes/auth.ts | Updated: signup creates org, /me returns org |

## Order of operations — IMPORTANT

Do this **before launching to customers** because the migration touches
every existing business row.

### 1. Backup your Supabase database

In Supabase dashboard → Database → Backups → Create backup.
Do not skip this. If anything goes wrong with the migration you can roll back.

### 2. Run the SQL migration

Open Supabase SQL Editor, paste the entire contents of
`migration/001-add-orgs-and-rbac.sql`, click Run.

You should see "Success. No rows returned" or similar.

Then run these verification queries in a NEW SQL tab:

    select count(*) from auth.users;
    select count(*) from public.organizations;
    select count(*) from public.org_members;
    select count(*) from public.businesses where org_id is null;

The first two numbers should match. The third number should equal
the first (one membership row per user, with role = 'owner').
The fourth number must be 0 — no business should be without an org.

### 3. Copy the backend files into your project

The folder structure mirrors your existing project, so:

    cp -r apps/api/src/shared/types/rbac.ts  /workspaces/bizzrank/bizzrank-v10/apps/api/src/shared/types/
    cp -r apps/api/src/domains/orgs/         /workspaces/bizzrank/bizzrank-v10/apps/api/src/domains/
    cp    apps/api/src/api/middleware/orgContext.ts  /workspaces/bizzrank/bizzrank-v10/apps/api/src/api/middleware/
    cp    apps/api/src/api/routes/orgs.ts            /workspaces/bizzrank/bizzrank-v10/apps/api/src/api/routes/
    cp    apps/api/src/api/routes/auth.ts            /workspaces/bizzrank/bizzrank-v10/apps/api/src/api/routes/

(Or unzip the bundle over your project — same result.)

### 4. Mount the new /api/orgs route

In `apps/api/src/index.ts` (or your `server.ts` if you've already split),
add the import and mount:

    import orgRoutes from './api/routes/orgs.js';
    // ...with the other route mounts...
    app.use('/api/orgs', orgRoutes);

### 5. Restart the API

Ctrl+C in your `npm run dev` terminal, then `npm run dev` again.
Watch for clean startup. If you see import errors, the file paths
in the imports vs. your project layout don't match — check the
relative paths in the source files.

### 6. Smoke test

With curl or Postman, get a JWT (via /login), then:

    curl -H "Authorization: Bearer YOUR_JWT" \
         https://api.bizzrank.com/api/orgs

You should see your personal org and yourself listed as the owner.

## What this enables you to do TODAY

Once installed, these endpoints work:

| Endpoint | Method | Who can call | What it does |
|----------|--------|--------------|--------------|
| /api/orgs | GET | any member | Org details + member list |
| /api/orgs/members | GET | any member | List of members |
| /api/orgs/invitations | POST | owner | Create + send invitation |
| /api/orgs/invitations | GET | owner | List pending invitations |
| /api/orgs/invitations/:id | DELETE | owner | Revoke pending invitation |
| /api/orgs/invitations/accept | POST | any | Accept by token |
| /api/orgs/members/:userId/role | PATCH | owner | Change member role |
| /api/orgs/members/:userId/budget | PATCH | owner | Set per-user credit budget |
| /api/orgs/members/:userId/password | POST | owner | Reset member password |
| /api/orgs/members/:userId | DELETE | owner | Remove member |
| /api/orgs/businesses/:id/assign | POST | owner | Grant user access to a business |
| /api/orgs/businesses/:id/assign/:userId | DELETE | owner | Revoke access |
| /api/orgs/businesses/:id/access | GET | owner | List users with access to a business |

## What's NOT YET ENFORCED — next delivery covers this

Important: **your existing routes still use the old per-user-id model**.
A manager can technically still see all businesses owned by their user_id
even if you haven't granted them business access. To plug this hole,
the NEXT delivery updates these existing route files to use orgContext:

  - businesses.ts (filter by org + assigned access)
  - organicScans.ts (require scan.run + access to business)
  - adScans.ts (same)
  - reviews.ts (same)
  - leaderboard.ts (same)
  - competitors.ts (same)
  - dashboard.ts (filter aggregations by what user can see)
  - profile.ts (no change — profile is per-user)
  - citations.ts (require access)

Apply this RBAC foundation first, verify orgs and invitations work,
THEN tell me you're ready for the route-update delivery and I'll
generate updated versions of each route file with permission checks
inserted in the right places.

## Smoke-test scenarios

After installation, exercise these to verify nothing is broken:

  1. Sign up a brand-new user.
     → They get a new org. /api/orgs returns their org with role 'owner'.

  2. Existing user (from before migration) logs in.
     → Their old businesses still appear in /api/businesses.
     → /api/orgs returns the auto-created org with them as owner.

  3. Owner invites a new email.
     → /api/orgs/invitations returns the new pending invitation.
     → /api/orgs/invitations returns the new pending invitation.
     → Frontend can construct the accept URL from invitation.token.

  4. Owner assigns a business to a member.
     → POST /api/orgs/businesses/:id/assign with userId in body.
     → GET /api/orgs/businesses/:id/access returns the new grant.

If all four work, the foundation is solid.

## Rollback plan if something goes wrong

If you need to revert:

    begin;
    drop table if exists public.org_invitations cascade;
    drop table if exists public.business_user_access cascade;
    drop table if exists public.org_members cascade;
    drop table if exists public.organizations cascade;
    alter table public.businesses drop column if exists org_id;
    alter table public.profiles drop column if exists current_org_id;
    commit;

This restores the previous schema. Your business and profile data
is untouched by the rollback — only the new tables and columns are removed.
