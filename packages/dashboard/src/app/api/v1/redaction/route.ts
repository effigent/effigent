import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db.ts';
import { resolveTenant } from '@/lib/tenant.ts';
import { invalidateRedactionCache } from '@/lib/agent-auth.ts';
import {
  BUILTIN_REDACTION_TYPES,
  MAX_CUSTOM_RULES,
  MAX_PATTERN_LENGTH,
  compileRedactionRules,
  type CustomRedactionRule,
} from '@/lib/engine/redact.ts';

export const dynamic = 'force-dynamic';

/**
 * Workspace redaction settings. Built-in patterns (API keys, credentials,
 * emails, cards, …) are ALWAYS on; org admins may add custom patterns that
 * run after them at the ingest choke point. In an organization only
 * `org:admin` can edit; a personal workspace's owner always can.
 */

let rulesCol: boolean | null = null;
async function hasRulesColumn(): Promise<boolean> {
  if (rulesCol !== null) return rulesCol;
  try {
    const r = await pool.query(
      `select 1 from information_schema.columns where table_name = 'tenants' and column_name = 'redaction_rules'`,
    );
    rulesCol = (r.rowCount ?? 0) > 0;
  } catch {
    rulesCol = false;
  }
  return rulesCol;
}

const canEditOf = (orgId: string | null | undefined, orgRole: string | null | undefined) =>
  !orgId || orgRole === 'org:admin' || orgRole === 'admin';

export async function GET() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });

  let rules: CustomRedactionRule[] = [];
  const migrated = await hasRulesColumn();
  if (migrated) {
    const r = await pool.query<{ redaction_rules: CustomRedactionRule[] | null }>(
      'select redaction_rules from tenants where id = $1',
      [tenantId],
    );
    rules = r.rows[0]?.redaction_rules ?? [];
  }
  return Response.json({
    rules,
    builtins: BUILTIN_REDACTION_TYPES,
    limits: { maxRules: MAX_CUSTOM_RULES, maxPatternLength: MAX_PATTERN_LENGTH },
    canEdit: canEditOf(orgId, orgRole),
    migrated,
  });
}

export async function PUT(req: Request) {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!canEditOf(orgId, orgRole)) {
    return Response.json({ error: 'only organization admins can edit redaction rules' }, { status: 403 });
  }
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });

  if (!(await hasRulesColumn())) {
    return Response.json(
      { error: 'redaction_rules column missing — run scripts/apply-ownership-redaction.mjs against prod first' },
      { status: 409 },
    );
  }

  let body: { rules?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { errors } = compileRedactionRules(body.rules);
  if (errors.length > 0) return Response.json({ error: 'invalid rules', errors }, { status: 400 });

  // Persist the normalized user-facing shape (name uppercased, enabled explicit).
  const rules = (Array.isArray(body.rules) ? body.rules : [])
    .slice(0, MAX_CUSTOM_RULES)
    .map((r) => {
      const rule = r as CustomRedactionRule;
      return {
        name: String(rule?.name ?? '').toUpperCase(),
        pattern: String(rule?.pattern ?? ''),
        enabled: rule?.enabled !== false,
      };
    });

  await pool.query('update tenants set redaction_rules = $2 where id = $1', [
    tenantId,
    JSON.stringify(rules),
  ]);
  invalidateRedactionCache(tenantId);
  return Response.json({ rules });
}
