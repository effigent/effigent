-- Ownership: which org user added/controls an agent, and who minted a key.
-- created_by = Clerk user id; created_by_label = denormalized display
-- (email/name) captured at write time so reads never need a Clerk lookup.
-- CLI registrations inherit ownership from the api key that performed them.
-- Idempotent (migrations re-run on every boot).
alter table api_keys add column if not exists created_by text;
alter table api_keys add column if not exists created_by_label text;
alter table agents   add column if not exists created_by text;
alter table agents   add column if not exists created_by_label text;
