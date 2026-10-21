-- Break-glass codes (FR Q18): short signed grants that lift a machine's
-- approval lists for a window while the control plane is unreachable. The
-- control plane signs the code with the tenant's ed25519 key and keeps only
-- its id (the nonce) and metadata here -- never the code itself.

create table if not exists cp.break_glass_codes (
  id             text primary key,            -- the grant nonce (hex); reported back by the machine that uses it
  tenant_ref     text not null,
  endpoint_id    text not null default '',    -- '' = any machine of the tenant
  reason         text not null,
  expiry         timestamptz not null,
  created_by     text not null,               -- console user id / apikey:<id>
  created_by_name text not null default '',
  created_via    text not null default '',    -- clerk | api-key | admin-token
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz,                 -- set when an admin revokes it (can't reach an offline machine)
  -- first use (an all-machines code may be used on several machines; the
  -- first is recorded here, every use is audited and emits a webhook).
  used_at        timestamptz,
  used_by        text not null default '',    -- the OS user who ran `effigentd break-glass` (self-asserted)
  used_on        text not null default ''     -- the endpoint id that used it
);

create index if not exists break_glass_tenant on cp.break_glass_codes (tenant_ref, created_at desc);
