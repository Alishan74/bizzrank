-- ============================================================
-- BizzRank v10 → Multi-tenant RBAC migration
-- ============================================================
-- Adds: organizations, members, business access, invitations,
-- per-user credit budgets.
--
-- SAFE to run on a populated database. Every existing user
-- becomes the owner of their own personal org. All their
-- existing businesses get auto-assigned to that org. No data
-- loss, no manual fixup required.
-- ============================================================

begin;

-- ── 1. ORGANIZATIONS ────────────────────────────────────────
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'starter',
  credits_pool integer not null default 0,
  credits_used_this_month integer not null default 0,
  monthly_allowance integer not null default 100,
  max_businesses integer not null default 1,
  max_users integer not null default 1,
  billing_cycle_start date default current_date,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_orgs_owner on public.organizations(owner_user_id);

-- ── 2. ORG MEMBERS ──────────────────────────────────────────
create table if not exists public.org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'manager', 'viewer', 'billing_admin')),
  monthly_credit_budget integer default 0,          -- 0 = no cap (uses org pool)
  credits_used_this_month integer default 0,
  created_at timestamptz default now(),
  invited_by uuid references auth.users(id),
  unique(org_id, user_id)
);

create index if not exists idx_org_members_org  on public.org_members(org_id);
create index if not exists idx_org_members_user on public.org_members(user_id);

-- ── 3. BUSINESS-USER ACCESS ─────────────────────────────────
create table if not exists public.business_user_access (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  granted_by uuid references auth.users(id),
  granted_at timestamptz default now(),
  unique(business_id, user_id)
);

create index if not exists idx_business_access_user on public.business_user_access(user_id);
create index if not exists idx_business_access_biz  on public.business_user_access(business_id);
create index if not exists idx_business_access_org  on public.business_user_access(org_id);

-- ── 4. INVITATIONS ──────────────────────────────────────────
create table if not exists public.org_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role text not null default 'viewer' check (role in ('manager', 'viewer', 'billing_admin')),
  invited_by uuid not null references auth.users(id),
  token text unique not null default encode(gen_random_bytes(24), 'hex'),
  expires_at timestamptz default (now() + interval '7 days'),
  accepted_at timestamptz,
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

-- ============================================================
-- DATA MIGRATION — make every existing user the owner of their own org
-- ============================================================

-- 1. Create one org per existing profile that doesn't have one yet
insert into public.organizations
  (name, plan, credits_pool, monthly_allowance, max_businesses, max_users, owner_user_id)
select
  coalesce(p.full_name, 'My') || '''s workspace',
  p.plan,
  p.credits_balance,
  p.monthly_allowance,
  p.max_businesses,
  case p.plan
    when 'starter'      then 1
    when 'professional' then 3
    when 'agency'       then 20
    when 'enterprise'   then 999
    else 1
  end,
  p.id
from public.profiles p
where not exists (
  select 1 from public.organizations o where o.owner_user_id = p.id
);

-- 2. Add each user as owner of their own org
insert into public.org_members (org_id, user_id, role)
select o.id, o.owner_user_id, 'owner'
from public.organizations o
where not exists (
  select 1 from public.org_members m
  where m.org_id = o.id and m.user_id = o.owner_user_id
);

-- 3. Set every profile's current_org_id to their own org
update public.profiles p
set current_org_id = o.id
from public.organizations o
where o.owner_user_id = p.id and p.current_org_id is null;

-- 4. Assign every existing business to its owner's org
update public.businesses b
set org_id = o.id
from public.organizations o
where b.user_id = o.owner_user_id and b.org_id is null;

-- 5. Grant existing owners access to their own businesses
insert into public.business_user_access (business_id, user_id, org_id, granted_by)
select b.id, b.user_id, b.org_id, b.user_id
from public.businesses b
where b.org_id is not null
  and not exists (
    select 1 from public.business_user_access a
    where a.business_id = b.id and a.user_id = b.user_id
  );

-- 6. Make org_id required now that every row has one
alter table public.businesses alter column org_id set not null;

commit;

-- ============================================================
-- VERIFICATION QUERIES (run separately to sanity-check)
-- ============================================================
-- select count(*) as users           from auth.users;
-- select count(*) as orgs            from public.organizations;
-- select count(*) as members         from public.org_members;
-- select count(*) as businesses      from public.businesses;
-- select count(*) as access_rows     from public.business_user_access;
-- select count(*) as orphan_business from public.businesses where org_id is null;
