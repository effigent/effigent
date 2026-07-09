-- Map a Clerk subject (organization or user) to a tenant. The dashboard
-- resolves tenants by this ref. Idempotent.
alter table tenants add column if not exists clerk_ref text;
create unique index if not exists tenants_clerk_ref on tenants (clerk_ref) where clerk_ref is not null;
