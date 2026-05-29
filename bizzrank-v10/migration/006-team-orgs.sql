-- BizzRank AI — Team / Organizations Tables
-- Run in Supabase SQL Editor

create extension if not exists "uuid-ossp";

create table if not exists public.organizations (
  id          uuid primary key default uuid_generate_v4(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  name        text not null default 'My Team',
  created_at  timestamptz not null default now(),
  constraint organizations_owner_unique unique (owner_id)
);
alter table public.organizations enable row level security;
create policy "Members view their org" on public.organizations
  using (id in (select org_id from public.org_members where user_id = auth.uid()));

create table if not exists public.org_members (
  id         uuid primary key default uuid_generate_v4(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'viewer'
    check (role in ('owner','manager','viewer')),
  created_at timestamptz not null default now(),
  constraint org_members_unique unique (org_id, user_id)
);
create index if not exists idx_org_members_user on public.org_members(user_id);
alter table public.org_members enable row level security;
create policy "Members view org roster" on public.org_members
  using (org_id in (select org_id from public.org_members where user_id = auth.uid()));

create table if not exists public.org_invitations (
  id          uuid primary key default uuid_generate_v4(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  invited_by  uuid not null references auth.users(id) on delete cascade,
  email       text not null,
  role        text not null default 'viewer'
    check (role in ('manager','viewer')),
  token       text not null default encode(gen_random_bytes(32), 'hex'),
  accepted    boolean not null default false,
  expires_at  timestamptz not null default (now() + interval '7 days'),
  created_at  timestamptz not null default now(),
  constraint org_invitations_token_unique unique (token)
);
alter table public.org_invitations enable row level security;
create policy "Org owners see invitations" on public.org_invitations
  using (org_id in (
    select org_id from public.org_members
    where user_id = auth.uid() and role = 'owner'
  ));

-- Seed orgs for all existing users
insert into public.organizations (owner_id, name)
select id, coalesce(raw_user_meta_data->>'company_name', 'My Team')
from auth.users
where id not in (select owner_id from public.organizations)
on conflict (owner_id) do nothing;

insert into public.org_members (org_id, user_id, role)
select o.id, o.owner_id, 'owner'
from public.organizations o
where o.owner_id not in (
  select user_id from public.org_members where role = 'owner'
)
on conflict (org_id, user_id) do nothing;

-- Verify:
-- select count(*) from public.organizations;
-- select count(*) from public.org_members;
