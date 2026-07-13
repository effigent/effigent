import { createHash } from 'node:crypto';
import { pool } from './db.ts';
import { putRunBlob } from './storage.ts';
import { sanitizeForJsonb } from './engine/jsonb.ts';
import {
  applyRedactionRules,
  compileRedactionRules,
  redactSensitive,
  type CompiledCustomRule,
} from './engine/redact.ts';
import type { Run } from './engine/types.ts';

export const hashKey = (k: string) => createHash('sha256').update(k).digest('hex');

export interface AgentAuth {
  tenantId: string;
  role: string;
  /** Set when the key is agent-scoped — forces attribution to that agent. */
  agentId?: string;
  agentName?: string;
  /** Clerk user id / display label of whoever minted this key (migration 009). */
  createdBy?: string;
  createdByLabel?: string;
}

/**
 * Migration-009 capability check, cached per process: prod ALTERs are applied
 * by an owner-run script, so every read/write of the ownership columns must
 * degrade gracefully until then.
 */
let ownershipCols: boolean | null = null;
export async function hasOwnershipColumns(): Promise<boolean> {
  if (ownershipCols !== null) return ownershipCols;
  try {
    const r = await pool.query(
      `select 1 from information_schema.columns where table_name = 'api_keys' and column_name = 'created_by'`,
    );
    ownershipCols = (r.rowCount ?? 0) > 0;
  } catch {
    ownershipCols = false;
  }
  return ownershipCols;
}

/** Bearer `eff_` (or legacy `cck_`) key → tenant (+ bound agent for scoped keys). */
export async function authenticateKey(header: string | null): Promise<AgentAuth | null> {
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token || !/^(eff|cck)_/.test(token)) return null;
  const withOwner = await hasOwnershipColumns();
  const { rows } = await pool.query<{
    tenant_id: string; role: string; agent_id: string | null; agent_name: string | null;
    created_by?: string | null; created_by_label?: string | null;
  }>(
    `select k.tenant_id, k.role, k.agent_id, a.name as agent_name${withOwner ? ', k.created_by, k.created_by_label' : ''}
       from api_keys k left join agents a on a.id = k.agent_id
      where k.key_hash = $1`,
    [hashKey(token)],
  );
  if (!rows.length) return null;
  const r = rows[0];
  pool.query('update api_keys set last_used_at = now() where key_hash = $1', [hashKey(token)]).catch(() => {});
  return {
    tenantId: r.tenant_id,
    role: r.role,
    agentId: r.agent_id ?? undefined,
    agentName: r.agent_name ?? undefined,
    createdBy: r.created_by ?? undefined,
    createdByLabel: r.created_by_label ?? undefined,
  };
}

/**
 * Org-defined redaction rules (migration 010), compiled + cached per tenant.
 * Missing column / bad rules degrade to built-ins only — ingest never breaks.
 */
const RULES_TTL_MS = 60_000;
const rulesCache = new Map<string, { compiled: CompiledCustomRule[]; at: number }>();
export function invalidateRedactionCache(tenantId: string): void {
  rulesCache.delete(tenantId);
}
async function tenantRedactionRules(tenantId: string): Promise<CompiledCustomRule[]> {
  const hit = rulesCache.get(tenantId);
  if (hit && Date.now() - hit.at < RULES_TTL_MS) return hit.compiled;
  let compiled: CompiledCustomRule[] = [];
  try {
    const r = await pool.query<{ redaction_rules: unknown }>(
      'select redaction_rules from tenants where id = $1',
      [tenantId],
    );
    compiled = compileRedactionRules(r.rows[0]?.redaction_rules).compiled;
  } catch {
    /* column not migrated yet → built-ins only */
  }
  rulesCache.set(tenantId, { compiled, at: Date.now() });
  return compiled;
}

/**
 * Persist a parsed Run — the single write path both capture shapes share.
 * Payloads are redacted + trimmed BEFORE storage (nothing sensitive is kept):
 * built-in patterns first, then the tenant's custom rules; jsonb-hostile
 * characters stripped (NULs, lone surrogates).
 *
 * S3-only residency: the redacted run blob is written to the ORG'S OWN bucket
 * and only its `s3://` URI + metadata land in Neon (`parsed` stays null). If the
 * workspace has no bucket configured, `putRunBlob` throws `StorageNotProvisioned`
 * — the caller turns that into a 409 (no bucket ⇒ no capture).
 */
export async function persistRun(auth: AgentAuth, sessionId: string, run: Run): Promise<void> {
  const custom = await tenantRedactionRules(auth.tenantId);
  const scrub = (text: string) => applyRedactionRules(redactSensitive(text), custom);
  const trimmed: Run = sanitizeForJsonb({
    ...run,
    firstPrompt: run.firstPrompt ? scrub(run.firstPrompt) : run.firstPrompt,
    finalOutput: run.finalOutput ? scrub(run.finalOutput) : run.finalOutput,
    steps: run.steps.map((s) => ({ ...s, payload: scrub(s.payload.slice(0, 8000)) })),
  });
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200);
  const blobPath = await putRunBlob(auth.tenantId, `${safe(run.agentId)}/${safe(sessionId)}.json.gz`, JSON.stringify(trimmed));
  await pool.query(
    `insert into runs (tenant_id, session_id, agent_id, started_at, ended_at,
                       cost_usd, models, n_steps, blob_path, parsed)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (tenant_id, session_id) do update
       set agent_id = excluded.agent_id, started_at = excluded.started_at,
           ended_at = excluded.ended_at, cost_usd = excluded.cost_usd,
           models = excluded.models, n_steps = excluded.n_steps,
           blob_path = excluded.blob_path, parsed = excluded.parsed`,
    [
      auth.tenantId,
      sessionId,
      run.agentId,
      run.startedAt ?? null,
      run.endedAt ?? null,
      run.costUsd,
      JSON.stringify(run.models),
      run.steps.length,
      blobPath, // s3://<org-bucket>/<agent>/<session>.json.gz
      null, // S3-only residency — no run content in Neon
    ],
  );
}
