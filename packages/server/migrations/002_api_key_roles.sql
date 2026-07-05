-- Key roles: raw session content (transcripts, run graphs) is owner-only.
-- Existing keys default to 'member' — dashboard, reports, clusters, sync,
-- analyze, insights keep working; /s and /g require an 'owner' key.
alter table api_keys add column if not exists role text not null default 'member';
