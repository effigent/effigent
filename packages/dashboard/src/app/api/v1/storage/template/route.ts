import { auth } from '@clerk/nextjs/server';
import { resolveTenant } from '@/lib/tenant.ts';
import { renderCfnTemplate, externalIdFor, effigentAccountId } from '@/lib/byo-template.ts';

export const dynamic = 'force-dynamic';

/**
 * The one-command BYO setup: a CloudFormation template pre-filled with this
 * org's external id and Effigent's AWS account id, so the partner's cloud team
 * runs a single `aws cloudformation deploy` with no hand-typed parameters.
 */
export async function GET() {
  const { userId, orgId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });

  const account = effigentAccountId();
  if (!account) {
    return Response.json(
      { error: 'EFFIGENT_AWS_ACCOUNT_ID not set in the dashboard deployment' },
      { status: 503 },
    );
  }
  const yaml = renderCfnTemplate({ externalId: externalIdFor(tenantId), effigentAccountId: account });
  return new Response(yaml, {
    headers: {
      'content-type': 'application/yaml; charset=utf-8',
      'content-disposition': 'attachment; filename="effigent-byo-storage.yaml"',
      'cache-control': 'no-store',
    },
  });
}
