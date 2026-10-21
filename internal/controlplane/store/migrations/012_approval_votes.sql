-- Who may approve, and how many. A request records when it is filed how it
-- must be decided (from the routing rule or default it matched, like
-- group_id): approvals_required (1, or 2 different people), exclude_requester
-- (the people behind the machine and OS user may not approve their own
-- request), require_ticket (approving needs a ticket reference), and who the
-- requester resolved to. Every decision is a vote: the request is approved
-- once approvals_required different people approved it, denied by the first
-- deny.
alter table cp.approvals
  add column if not exists approvals_required integer not null default 1,
  add column if not exists exclude_requester  boolean not null default true,
  add column if not exists require_ticket     boolean not null default false,
  add column if not exists requester          jsonb not null default '{}',
  add column if not exists slack_ref          text not null default ''; -- "channel:ts" of the app's message

create table if not exists cp.approval_votes (
  approval_id    text not null references cp.approvals (id),
  tenant_ref     text not null,
  voter          text not null, -- console user id, link:email:<addr>, slack:<team>:<user>, apikey:<id>, admin
  voter_user_id  text not null default '',
  voter_emails   text[] not null default '{}',
  voter_name     text not null default '',
  via            text not null, -- console | api-key | email | slack
  decision       text not null check (decision in ('approve', 'deny')),
  note           text not null default '',
  ticket         text not null default '', -- SEC-123 or a link
  admin_override boolean not null default false,
  at             timestamptz not null default now(),
  primary key (approval_id, voter)
);

-- Jira-style keys on votes become links: https://acme.atlassian.net/browse/{key}
alter table cp.notification_settings add column if not exists ticket_url_template text not null default '';
