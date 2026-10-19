-- People mapping: per tenant, who the people are (by work email) and which
-- other identities they go by — OS users (optionally on one host: dana@build-7),
-- hostnames, git emails, GitHub logins, other emails, vendor API key names.
-- Pricing Leaks joins vendor seats and effigentd's activity through it.
create table if not exists cp.people (
  tenant_ref  text not null,
  email       text not null,             -- lowercased work email: the person key
  name        text not null default '',
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  updated_by  text not null default '',
  updated_at  timestamptz not null default now(),
  primary key (tenant_ref, email)
);

create table if not exists cp.person_identities (
  tenant_ref  text not null,
  kind        text not null,             -- os_user | host | git_email | github | email | api_key
  value       text not null,             -- lowercased; os_user is "user" or "user@host"
  email       text not null,
  source      text not null default 'manual', -- manual | suggestion
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  primary key (tenant_ref, kind, value),
  foreign key (tenant_ref, email) references cp.people (tenant_ref, email) on delete cascade
);
create index if not exists person_identities_email on cp.person_identities (tenant_ref, email);

-- People kept in the Pricing Leaks settings (migration 009) move here. Aliases
-- without a kind: prefix are best-effort: an email becomes "email", anything else
-- "os_user" (a bare hostname alias needs re-mapping as host: on the People page).
insert into cp.people (tenant_ref, email, name)
select s.tenant_ref, lower(trim(p->>'email')), coalesce(p->>'name', '')
from cp.spend_settings s, jsonb_array_elements(coalesce(s.config->'people', '[]'::jsonb)) p
where coalesce(trim(p->>'email'), '') <> ''
on conflict do nothing;
insert into cp.person_identities (tenant_ref, kind, value, email)
select tenant_ref,
       case when k in ('os', 'os_user') then 'os_user' when k in ('key', 'api_key') then 'api_key'
            when k in ('host', 'git_email', 'github', 'email') then k
            when a like '%@%' then 'email' else 'os_user' end,
       case when k in ('os', 'os_user', 'key', 'api_key', 'host', 'git_email', 'github', 'email') then substr(a, length(k) + 2) else a end,
       email
from (select s.tenant_ref, lower(trim(p->>'email')) email, lower(trim(a)) a, split_part(lower(trim(a)), ':', 1) k
      from cp.spend_settings s, jsonb_array_elements(coalesce(s.config->'people', '[]'::jsonb)) p,
           jsonb_array_elements_text(coalesce(p->'aliases', '[]'::jsonb)) a
      where coalesce(trim(p->>'email'), '') <> '' and trim(a) <> '') x
on conflict do nothing;
update cp.spend_settings set config = config - 'people';

-- What effigentd saw, per day: one row per machine, agent, OS user, git
-- email and model. cp.events is append-only, so this rollup is kept next to
-- it, upserted in the same transaction as each ingested batch.
create table if not exists cp.agent_activity_daily (
  tenant_ref   text not null,
  endpoint_id  uuid not null,
  day          date not null,
  agent        text not null,
  os_user      text not null default '',
  git_email    text not null default '',
  model        text not null default '',
  events       bigint not null default 0,
  first_at     timestamptz not null,
  last_at      timestamptz not null,
  primary key (tenant_ref, endpoint_id, day, agent, os_user, git_email, model)
);
create index if not exists agent_activity_daily_day on cp.agent_activity_daily (tenant_ref, day);

-- Backfill the last 35 days (older events carry no os_user / git_email).
insert into cp.agent_activity_daily (tenant_ref, endpoint_id, day, agent, os_user, git_email, model, events, first_at, last_at)
select tenant_ref, endpoint_id, (event_time at time zone 'UTC')::date, agent,
       left(lower(coalesce(body->>'os_user', '')), 200), left(lower(coalesce(body->>'git_email', '')), 254), left(coalesce(body->>'model', ''), 120),
       count(*), min(event_time), max(event_time)
from cp.events
where event_time >= now() - interval '35 days' and agent <> '' and agent not like 'mcp:%'
group by 1, 2, 3, 4, 5, 6, 7
on conflict do nothing;

-- Vendor poller: each connector is polled when next_poll_at is due, under a
-- per tenant+vendor advisory lock (safe with several control plane instances).
alter table cp.spend_connectors add column if not exists next_poll_at timestamptz;
alter table cp.spend_connectors add column if not exists failures int not null default 0;
create index if not exists spend_connectors_due on cp.spend_connectors (next_poll_at) where secret_enc <> '' and enabled;
