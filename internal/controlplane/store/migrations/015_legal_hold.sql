-- Per-tenant event retention and legal hold. retention_days overrides the
-- control plane's EFFIGENT_EVENT_RETENTION_DAYS (0 = use it; never under 90).
-- A legal hold stops every event deletion for the tenant, and puts an S3
-- Object Lock legal hold on its archive objects; the hold_* columns track
-- that S3 sync, which is idempotent and re-run until it succeeds.
create table if not exists cp.event_retention (
  tenant_ref       text primary key,
  retention_days   integer not null default 0 check (retention_days = 0 or retention_days >= 90),
  legal_hold       boolean not null default false,
  hold_reason      text not null default '',
  hold_set_by      text not null default '',
  hold_set_at      timestamptz,
  -- the archive objects' legal hold: generation bumps on every change, the
  -- sync records the generation it finished, so a sync that raced a change
  -- runs again
  hold_generation  integer not null default 0,
  hold_synced      integer not null default 0,
  hold_objects     integer not null default 0, -- object versions set in the last sync
  hold_synced_at   timestamptz,
  hold_error       text not null default '',
  updated_by       text not null default '',
  updated_at       timestamptz not null default now()
);

-- which S3 version of each archive the control plane wrote last (a day
-- archived twice is two versions of one key; downloads name the version)
alter table cp.event_archives
  add column if not exists version_id text not null default '';

-- the delete guard: retention may delete events older than 90 days, never
-- a held tenant's
create or replace function cp.events_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('effigent.retention', true), '') = 'on'
     and old.ingested_at < now() - interval '90 days'
     and not exists (select 1 from cp.event_retention h where h.tenant_ref = old.tenant_ref and h.legal_hold) then
    return old;
  end if;
  raise exception 'cp.events is append-only (events leave only through retention, after archiving, once older than 90 days, and never under a legal hold)';
end $$;
