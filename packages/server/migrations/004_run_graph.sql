-- Persist the execution DAG (RunGraph / IR) per run. The graph itself lives in
-- the blob store (gzipped, decompressed on demand); this column is the pointer.
-- Idempotent (migrations re-run on every boot).
alter table runs add column if not exists graph_blob_path text;
