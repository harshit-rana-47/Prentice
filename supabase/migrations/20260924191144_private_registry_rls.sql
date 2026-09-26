-- Defense in depth. These tables are not in the Data API, and no client
-- policy is granted. The cloud process connects as the database owner,
-- which bypasses row-level security.

alter table prentice_private.device_credentials enable row level security;
alter table prentice_private.pairing_codes enable row level security;
