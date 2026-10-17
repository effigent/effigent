-- Agent events become tamper-evident and archivable.
--
-- Every ingested batch gets a row in cp.event_batches, chained per endpoint:
-- content_hash covers the batch's events as Postgres stores them (computed
-- here in SQL, the same way at ingest and at verify), hash covers the batch
-- row and the previous batch's hash. Events are append-only; the only way to
-- delete one is the retention job (session setting effigent.retention = on)
-- and only once it is older than 90 days — after it was archived to S3. A
-- batch row outlives its events (archived_at, archive_key), so the chain
-- still verifies after retention.

create table if not exists cp.event_batches (
  id              bigserial primary key,
  tenant_ref      text not null,
  endpoint_id     uuid not null,
  client_batch_id text not null,
  received_at     timestamptz not null,
  first_id        bigint,
  last_id         bigint,
  count           integer not null,
  content_hash    text not null,
  prev_hash       text not null,
  hash            text not null,
  archived_at     timestamptz,
  archive_key     text not null default '',
  archive_sha256  text not null default '',
  unique (endpoint_id, client_batch_id)
);
create index if not exists event_batches_chain on cp.event_batches (tenant_ref, endpoint_id, id);
create index if not exists event_batches_due on cp.event_batches (received_at) where archived_at is null;

-- One row per archived tenant-day (the S3 object), kept forever.
create table if not exists cp.event_archives (
  tenant_ref   text not null,
  day          date not null,
  key          text not null,
  sha256       text not null,
  size         bigint not null,
  batches      integer not null,
  events       bigint not null,
  legacy       bigint not null,
  archived_at  timestamptz not null default now(),
  primary key (tenant_ref, day)
);

alter table cp.events add column if not exists batch_id bigint;
create index if not exists events_batch on cp.events (batch_id);
-- paging is (event_time desc, id desc)
create index if not exists events_tenant_time_id on cp.events (tenant_ref, event_time desc, id desc);
drop index if exists cp.events_tenant_time;
-- events from before this migration carry no batch
create index if not exists events_legacy on cp.events (ingested_at) where batch_id is null;

-- One event as hashed: fixed formatting, independent of the session's time zone.
create or replace function cp.event_text(e cp.events) returns text language sql stable as $$
  select e.id::text || '|' || e.endpoint_id::text || '|' ||
         to_char(e.event_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' ||
         e.type || '|' || e.severity || '|' || e.agent || '|' || e.body::text
$$;

-- The content hash of a batch: its events, in id order.
create or replace function cp.event_batch_content(batch bigint) returns text language sql stable as $$
  select encode(sha256(convert_to(coalesce(string_agg(cp.event_text(e), E'\n' order by e.id), ''), 'UTF8')), 'hex')
  from cp.events e where e.batch_id = batch
$$;

-- The chain hash of a batch row.
create or replace function cp.event_batch_hash(tenant text, endpoint uuid, client_batch text, received timestamptz,
    first_id bigint, last_id bigint, n integer, content text, prev text) returns text language sql stable as $$
  select encode(sha256(convert_to(concat_ws('|', tenant, endpoint::text, client_batch,
    to_char(received at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(first_id, 0)::text, coalesce(last_id, 0)::text, n::text, content, prev), 'UTF8')), 'hex')
$$;

-- Events: never updated; deleted only by the retention job, only when old enough.
create or replace function cp.events_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('effigent.retention', true), '') = 'on'
     and old.ingested_at < now() - interval '90 days' then
    return old;
  end if;
  raise exception 'cp.events is append-only (events leave only through retention, after archiving, once older than 90 days)';
end $$;
drop trigger if exists events_append_only on cp.events;
create trigger events_append_only before update or delete on cp.events
  for each row execute function cp.events_guard();

-- Batches: never deleted; only the archive columns may be filled in, once.
create or replace function cp.event_batches_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.archived_at is null
     and (new.id, new.tenant_ref, new.endpoint_id, new.client_batch_id, new.received_at, new.first_id, new.last_id,
          new.count, new.content_hash, new.prev_hash, new.hash)
     is not distinct from
         (old.id, old.tenant_ref, old.endpoint_id, old.client_batch_id, old.received_at, old.first_id, old.last_id,
          old.count, old.content_hash, old.prev_hash, old.hash) then
    return new;
  end if;
  raise exception 'cp.event_batches is append-only';
end $$;
drop trigger if exists event_batches_append_only on cp.event_batches;
create trigger event_batches_append_only before update or delete on cp.event_batches
  for each row execute function cp.event_batches_guard();
