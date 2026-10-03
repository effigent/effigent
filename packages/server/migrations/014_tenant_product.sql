-- Which Effigent product a workspace uses:
--   'insights' — capture + read-only analysis (CLI hooks, OTel, the Insights views)
--   'runtime'  — the @effigent/runtime SDK inside the customer's API agent (+ policies)
--   'both'
-- The default keeps every existing workspace exactly where it is. Readers column-guard
-- this (lib/tenant-settings.ts) and treat a missing column as 'insights'.
-- Idempotent: `add column if not exists`; the check constraint is added only once.
alter table tenants add column if not exists product text not null default 'insights';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_product_check') then
    alter table tenants add constraint tenants_product_check check (product in ('insights', 'runtime', 'both'));
  end if;
end $$;
