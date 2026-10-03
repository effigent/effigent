import { auth } from '@clerk/nextjs/server';
import { resolveTenant } from '@/lib/tenant.ts';
import { getTenantProduct, hasProductColumn, isProduct, setTenantProduct, PRODUCTS } from '@/lib/tenant-settings.ts';

export const dynamic = 'force-dynamic';

/**
 * Workspace product choice: insights | runtime | both (see lib/tenant-settings.ts).
 * In an organization only `org:admin` can change it; a personal workspace's owner
 * always can.
 */

const canEditOf = (orgId: string | null | undefined, orgRole: string | null | undefined) =>
  !orgId || orgRole === 'org:admin' || orgRole === 'admin';

export async function GET() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });
  return Response.json({
    product: await getTenantProduct(tenantId),
    options: PRODUCTS,
    canEdit: canEditOf(orgId, orgRole),
    migrated: await hasProductColumn(),
  });
}

export async function PUT(req: Request) {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!canEditOf(orgId, orgRole)) {
    return Response.json({ error: 'only organization admins can change the product' }, { status: 403 });
  }
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });

  if (!(await hasProductColumn())) {
    return Response.json(
      { error: 'product column missing — run scripts/apply-tenant-product.mjs against prod first' },
      { status: 409 },
    );
  }

  let body: { product?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (!isProduct(body.product)) {
    return Response.json({ error: `product must be one of ${PRODUCTS.join(' | ')}` }, { status: 400 });
  }
  await setTenantProduct(tenantId, body.product);
  return Response.json({ product: body.product });
}
