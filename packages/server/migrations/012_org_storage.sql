-- Per-org run storage (S3-only residency). Each org's run blobs live in its own
-- bucket; Neon keeps only metadata + aggregates. storage_role_arn set => BYO
-- cross-account bucket (assume-role); null => an Effigent-account bucket.
-- Capture is blocked until storage_bucket is set (the onboarding gate).
alter table tenants add column if not exists storage_bucket text;
alter table tenants add column if not exists storage_region text;
alter table tenants add column if not exists storage_prefix text;
alter table tenants add column if not exists storage_kms_key text;
alter table tenants add column if not exists storage_role_arn text;
alter table tenants add column if not exists storage_external_id text;
alter table tenants add column if not exists storage_provisioned_at timestamptz;
