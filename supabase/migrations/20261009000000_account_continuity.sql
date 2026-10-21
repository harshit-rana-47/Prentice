-- Account-owned, deliberately small projections of local work. The cloud API
-- writes these tables; neither browser nor connector gets direct table access.
create table prentice_private.sync_projects (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  origin_device_id text not null,
  display_name text not null check (char_length(display_name) between 1 and 200),
  created_at timestamptz not null,
  last_active_at timestamptz not null,
  primary key (user_id, id)
);

create table prentice_private.sync_activity (
  user_id uuid not null,
  id uuid not null,
  project_id uuid not null,
  origin_device_id text not null,
  created_at timestamptz not null,
  finished_at timestamptz,
  status text not null check (status in ('completed', 'failed', 'interrupted')),
  provider_id text,
  files_added integer not null check (files_added between 0 and 100000),
  files_modified integer not null check (files_modified between 0 and 100000),
  files_deleted integer not null check (files_deleted between 0 and 100000),
  tests_passed integer check (tests_passed between 0 and 100000),
  tests_failed integer check (tests_failed between 0 and 100000),
  primary key (user_id, id),
  foreign key (user_id, project_id) references prentice_private.sync_projects(user_id, id) on delete cascade
);

create index sync_activity_recent_idx on prentice_private.sync_activity (user_id, created_at desc);

create table prentice_private.sync_concepts (
  user_id uuid not null,
  project_id uuid not null,
  concept text not null check (char_length(concept) between 1 and 160),
  state text not null check (state in ('explored', 'understood')),
  recorded_at timestamptz not null,
  primary key (user_id, project_id, concept),
  foreign key (user_id, project_id) references prentice_private.sync_projects(user_id, id) on delete cascade
);

alter table prentice_private.sync_projects enable row level security;
alter table prentice_private.sync_activity enable row level security;
alter table prentice_private.sync_concepts enable row level security;
revoke all on prentice_private.sync_projects, prentice_private.sync_activity, prentice_private.sync_concepts from public, anon, authenticated;
