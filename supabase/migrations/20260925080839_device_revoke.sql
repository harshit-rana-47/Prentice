alter table public.devices
  add column revoked_at timestamptz;

create index devices_active_user_id_idx on public.devices (user_id) where revoked_at is null;
