-- Device registry, pairing codes, and project display names.
-- Prentice accounts live in auth.users. Token hashes and pairing codes stay
-- out of the Data API.

create schema if not exists prentice_private;

revoke all on schema prentice_private from public;
revoke all on schema prentice_private from anon, authenticated;

create table public.devices (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  public_key text not null check (char_length(public_key) between 1 and 4096),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  paired_at timestamptz not null default now()
);

create index devices_user_id_idx on public.devices (user_id);

create table prentice_private.device_credentials (
  device_id text primary key references public.devices (id) on delete cascade,
  token_hash text not null unique check (char_length(token_hash) = 64)
);

create table prentice_private.pairing_codes (
  code text primary key check (char_length(code) = 8),
  user_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index pairing_codes_user_id_idx on prentice_private.pairing_codes (user_id);

create table public.project_metadata (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id text not null references public.devices (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 200),
  created_at timestamptz not null default now()
);

create index project_metadata_user_id_idx on public.project_metadata (user_id);
create index project_metadata_device_id_idx on public.project_metadata (device_id);

alter table public.devices enable row level security;
alter table public.project_metadata enable row level security;

revoke all on table public.devices from anon, authenticated;
revoke all on table public.project_metadata from anon, authenticated;
grant select on table public.devices to authenticated;
grant select on table public.project_metadata to authenticated;

create policy devices_select_own
  on public.devices
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy project_metadata_select_own
  on public.project_metadata
  for select
  to authenticated
  using ((select auth.uid()) = user_id);
