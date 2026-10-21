-- Cloud environments: a vendor-hosted agent environment (Claude Code on the
-- web, GitHub Copilot cloud agent, Cursor cloud agents) whose repo hooks run
-- `effigentd hook <agent> --remote`. It is one endpoint shared by every
-- session of that environment, created from the console (no enrollment), and
-- authenticates with its endpoint secret like any machine.
alter table cp.endpoints add column if not exists kind text not null default 'machine';
alter table cp.endpoints add column if not exists cloud_vendor text not null default '';
alter table cp.endpoints drop constraint if exists endpoints_kind_check;
alter table cp.endpoints add constraint endpoints_kind_check check (kind in ('machine', 'cloud'));
