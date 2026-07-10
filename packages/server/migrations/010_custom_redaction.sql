-- Org-admin custom redaction rules, applied at ingest AFTER the built-ins.
-- Shape: [{"name":"TICKET_ID","pattern":"JIRA-\\d+","enabled":true}, …]
-- Validated + compiled by core redact.ts (count/length caps, safe names).
alter table tenants add column if not exists redaction_rules jsonb not null default '[]'::jsonb;
