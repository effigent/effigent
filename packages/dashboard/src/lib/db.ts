import { Pool } from 'pg';

// Single pooled client, cached on globalThis so serverless/dev hot-reload doesn't
// open a new pool per invocation. Use Neon's pooled connection string in prod.
const url = process.env.DATABASE_URL ?? 'postgres://ccopt:ccopt@localhost:5433/ccopt';
const needsSsl = /sslmode=(require|verify)/.test(url);

const g = globalThis as unknown as { __ccoptPool?: Pool };
export const pool: Pool =
  g.__ccoptPool ??
  new Pool({
    connectionString: url,
    max: 5,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
if (!g.__ccoptPool) g.__ccoptPool = pool;
