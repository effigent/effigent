import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db.ts';
import { resolveTenant } from '@/lib/tenant.ts';
import { evaluateRouting, type RouteSample } from '@/lib/engine/routing.ts';
import { pricingFor } from '@/lib/engine/cost.ts';
import { callOpenRouter, hasOpenRouterKey } from '@/lib/openrouter.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // many live model calls

interface DbStep { kind: string; name: string; payload: string }
interface RunRow {
  session_id: string;
  steps: DbStep[] | null;
  first_prompt: string | null;
  final_output: string | null;
  models: string[] | null;
}

/** Approximate the model's input for a run: the task + the recorded trajectory,
 *  minus the final answer (which is what the smaller model must reproduce). */
function reconstructContext(run: RunRow): string {
  const parts: string[] = [];
  if (run.first_prompt) parts.push(`# Task\n${run.first_prompt.slice(0, 2000)}`);
  parts.push('# Session so far');
  for (const s of run.steps ?? []) {
    const p = (s.payload ?? '').slice(0, 800);
    if (s.kind === 'tool_use') parts.push(`- called ${s.name}: ${p}`);
    else if (s.kind === 'tool_result') parts.push(`  → ${p}`);
    else if (s.kind === 'model_turn') parts.push(`- assistant: ${p}`);
  }
  parts.push('# Produce the final response for this task.');
  return parts.join('\n').slice(0, 6000);
}

/**
 * Initiate a smaller-model test for an agent: try cheaper same-vendor models on
 * the recorded runs and report which (if any) reproduces the outcome — the
 * "does a smaller model break the flow?" check. Live OpenRouter calls, key stays
 * server-side. (Manual for now; automation later.)
 */
export async function GET(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!hasOpenRouterKey()) {
    return Response.json({ available: false, note: 'Model-routing tests need OPENROUTER_API_KEY on the server.' });
  }
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });
  const agent = new URL(req.url).searchParams.get('agent');
  if (!agent) return Response.json({ error: 'agent required' }, { status: 400 });

  const { rows } = await pool.query<RunRow>(
    `select session_id, parsed->'steps' as steps, parsed->>'firstPrompt' as first_prompt,
            parsed->>'finalOutput' as final_output, parsed->'models' as models
       from runs
      where tenant_id = $1 and agent_id = $2 and parsed->>'finalOutput' is not null
      order by started_at desc nulls last limit 6`,
    [tenantId, agent],
  );
  const usable = rows.filter((r) => r.final_output && (r.steps?.length ?? 0) > 0);
  if (usable.length < 2) {
    return Response.json({ available: true, status: 'insufficient', note: 'Need at least 2 runs with a final output to test.' });
  }

  const counts = new Map<string, number>();
  for (const r of usable) { const m = r.models?.[0]; if (m) counts.set(m, (counts.get(m) ?? 0) + 1); }
  const originalModel = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  const samples: RouteSample[] = usable.map((r) => ({
    input: reconstructContext(r),
    expectedOutput: r.final_output ?? '',
    runId: r.session_id,
  }));

  let report;
  try {
    report = await evaluateRouting(originalModel, samples, {
      callModel: (m, input) => callOpenRouter(m, input, { maxTokens: 1200, timeoutMs: 30_000 }),
      minSamples: Math.min(5, samples.length),
      retries: 1,
      threshold: 0.8,
      matchThreshold: 0.7,
    });
  } catch (err) {
    console.error(`[route-test] failed tenant=${tenantId} agent=${agent}:`, err);
    return Response.json({ available: true, status: 'error', note: 'Routing test failed — see server logs.' }, { status: 200 });
  }

  let savingsShare: number | null = null;
  if (report.chosen) {
    try {
      const o = pricingFor(originalModel).inputPerM;
      const c = pricingFor(report.chosen.model).inputPerM;
      if (o > 0) savingsShare = Math.max(0, Math.round((1 - c / o) * 100) / 100);
    } catch { /* pricing best-effort */ }
  }
  return Response.json({ available: true, agent, ...report, savingsShare });
}
