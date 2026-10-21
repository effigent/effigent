-- Four-eyes policy changes. With policy_change_approval on, every change
-- that would publish a policy version (the policy itself, an exception, a
-- machine's owner/teams) is filed as a proposal and applied only when
-- another admin approves it.
create table if not exists cp.policy_settings (
  tenant_ref              text primary key,
  policy_change_approval  boolean not null default false,
  updated_by              text not null default '',
  updated_at              timestamptz not null default now()
);

create table if not exists cp.policy_proposals (
  id            text primary key,
  tenant_ref    text not null,
  kind          text not null check (kind in ('policy', 'exception.create', 'exception.delete', 'endpoint.owner', 'settings')),
  payload       jsonb not null,
  summary       text not null default '',
  base_version  bigint not null default 0, -- the latest version when it was proposed
  author        text not null,
  author_name   text not null default '',
  author_via    text not null default '',
  author_owner  text not null default '', -- an API key author: the console user who created the key
  state         text not null default 'pending' check (state in ('pending', 'approved', 'rejected', 'superseded', 'withdrawn')),
  decided_by    text not null default '',
  decided_name  text not null default '',
  note          text not null default '',
  version       bigint not null default 0, -- the version it published when applied
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);

create index if not exists policy_proposals_tenant on cp.policy_proposals (tenant_ref, created_at desc);
create index if not exists policy_proposals_pending on cp.policy_proposals (tenant_ref) where state = 'pending';
