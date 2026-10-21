-- Console users seen at sign-in (self-hosted OIDC). Clerk keeps its own
-- directory; with a generic OIDC provider the control plane has no directory
-- API to ask, so it remembers who signed in: the Team page lists them, and the
-- approver checks (Slack, the requester rule) read their verified emails and
-- roles from here. A user appears after their first sign-in; the role is what
-- their last token said.
create table if not exists cp.console_users (
  tenant_ref  text not null,
  user_id     text not null,            -- the token's subject (configurable claim)
  email       text not null default '', -- lower-case, verified only ('' otherwise)
  name        text not null default '',
  role        text not null default 'member',
  groups      text[] not null default '{}',
  via         text not null default 'oidc',
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  primary key (tenant_ref, user_id)
);
create index if not exists console_users_email on cp.console_users (tenant_ref, lower(email)) where email <> '';
