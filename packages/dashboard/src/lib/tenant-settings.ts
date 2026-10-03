import { pool } from '@/lib/db.ts';

/**
 * Which Effigent product a workspace uses (migration 014, `tenants.product`):
 *  - `insights` — capture + read-only analysis (CLI hooks, OTel, Insights views)
 *  - `runtime`  — the @effigent/runtime SDK inside the customer's API agent (+ policies)
 *  - `both`
 * A missing column (migration not yet applied) reads as `insights`, so every existing
 * workspace keeps working before the owner runs scripts/apply-tenant-product.mjs.
 *
 * Gating rule: this setting hides product SURFACES (views, the policies endpoint,
 * runtime-SDK ingest). It never drops CLI/hook captures — a workspace that switches
 * products must not silently lose sessions.
 */
export type Product = 'insights' | 'runtime' | 'both';
export const PRODUCTS: readonly Product[] = ['insights', 'runtime', 'both'];
export const isProduct = (v: unknown): v is Product => typeof v === 'string' && (PRODUCTS as readonly string[]).includes(v);

export const usesInsights = (p: Product) => p !== 'runtime';
export const usesRuntime = (p: Product) => p !== 'insights';

let productCol: boolean | null = null;
export async function hasProductColumn(): Promise<boolean> {
  if (productCol !== null) return productCol;
  try {
    const r = await pool.query(
      `select 1 from information_schema.columns where table_name = 'tenants' and column_name = 'product'`,
    );
    productCol = (r.rowCount ?? 0) > 0;
  } catch {
    productCol = false;
  }
  return productCol;
}

// Ingest reads this on every upload; same 60s per-tenant cache as the redaction rules.
const TTL_MS = 60_000;
const cache = new Map<string, { product: Product; at: number }>();

export async function getTenantProduct(tenantId: string): Promise<Product> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.product;
  let product: Product = 'insights';
  if (await hasProductColumn()) {
    try {
      const r = await pool.query<{ product: string | null }>('select product from tenants where id = $1', [tenantId]);
      const v = r.rows[0]?.product;
      if (isProduct(v)) product = v;
    } catch {
      /* unreadable → the default; never block a request on this */
    }
  }
  cache.set(tenantId, { product, at: Date.now() });
  return product;
}

export async function setTenantProduct(tenantId: string, product: Product): Promise<void> {
  await pool.query('update tenants set product = $2 where id = $1', [tenantId, product]);
  cache.set(tenantId, { product, at: Date.now() });
}
