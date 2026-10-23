-- The kernel layer as effigentd reports it with each heartbeat: its sensor,
-- whether BPF LSM is in the kernel's active LSM list and whether Tetragon is
-- connected. A Linux machine without either only observes. Null = an
-- effigentd build that doesn't report it.
alter table cp.endpoints add column if not exists kernel jsonb;
alter table cp.endpoints add column if not exists kernel_reported_at timestamptz;
