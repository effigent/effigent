-- Central policy (internal/shared/policy) compiled per machine at serve time.
-- An endpoint's owner (console user id or email) and teams are what rules
-- scoped to users and teams match against.
alter table cp.endpoints add column if not exists owner text not null default '';
alter table cp.endpoints add column if not exists teams text[] not null default '{}';

-- When set, `body` is the base endpoint policy (agent detection, modes,
-- alerts) and `source` the central policies compiled onto it for each machine.
alter table cp.policy_versions add column if not exists source jsonb;
