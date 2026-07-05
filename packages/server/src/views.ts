/**
 * Browser views: /ui (workspace dashboard) and /s/:sessionId (transcript viewer,
 * rendered from the raw S3 blob — full fidelity, not the trimmed DB copy).
 * Auth for browsers: ?key=cck_… query param (same tenant API key as the CLI).
 */

import { runGraphSvg, type Run, type RunGraph, type VolatileSlot } from '@ccopt/core';

/** HTML-escape any value — pg returns Dates for timestamptz, numerics as strings. */
function esc(v: unknown): string {
  const s = v instanceof Date ? v.toISOString() : String(v ?? '—');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function usd(n: number | string | null | undefined): string {
  const v = typeof n === 'string' ? Number(n) : n;
  return v == null || Number.isNaN(v) ? '—' : `$${v.toFixed(2)}`;
}

const SHELL_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #fafafa; color: #1a1a1e; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 20px 80px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 10px; }
  .sub { color: #66666e; font-size: 13px; margin-bottom: 18px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e4e4e8; border-radius: 10px; overflow: hidden; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
  th { background: #f4f4f6; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #66666e; }
  a { color: #5b3df5; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-size: 12px; }
`;

export interface AgentRow {
  agent_id: string;
  n_runs: number;
  total_cost_usd: string;
  last_seen: string | Date | null;
}
export interface RunRow {
  session_id: string;
  agent_id: string;
  started_at: string | Date | null;
  cost_usd: string;
  n_steps: number;
}
export interface ReportRow {
  id: string;
  generated_at: string | Date;
  totals: { runs?: number; costUsd?: number };
}

export interface AiInsightRow {
  title: string;
  category: string;
  est_monthly_saving_usd: number;
  performance_risk: string;
  rationale: string;
  implementation: string;
  evidence_runs?: string[];
}
export interface AiInsightsBlock {
  summary: string;
  insights: AiInsightRow[];
  model: string;
  provider?: string;
  generatedAt: string;
  runsAnalyzed?: number;
}

export interface OptimizeState {
  agentFilter?: string;
  newRunsSince: number;
  canRun: boolean;
}

export function renderDashboardHtml(
  tenantName: string,
  agents: AgentRow[],
  runs: RunRow[],
  reports: ReportRow[],
  key: string,
  aiInsights?: AiInsightsBlock,
  optimize?: OptimizeState,
): string {
  const k = encodeURIComponent(key);
  const agentQ = optimize?.agentFilter ? `&agent=${encodeURIComponent(optimize.agentFilter)}` : '';
  const optimizeHtml = optimize
    ? `<div style="display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #e4e4e8;border-radius:10px;padding:12px 16px;margin:14px 0">
  <form method="post" action="/api/v1/insights?redirect=1&key=${k}${agentQ}" style="margin:0">
    <button type="submit" ${optimize.canRun ? '' : 'disabled'} style="padding:8px 16px;border-radius:8px;border:none;background:${optimize.canRun ? '#5b3df5' : '#c9c9cf'};color:#fff;font-weight:700;cursor:${optimize.canRun ? 'pointer' : 'not-allowed'}">
      Run optimization${optimize.agentFilter ? ` for ${esc(optimize.agentFilter)}` : ''}
    </button>
  </form>
  <span style="font-size:12px;color:#66666e">
    ${optimize.canRun
      ? `${optimize.newRunsSince} new run(s) since the last analysis — ready.`
      : `up to date: only ${optimize.newRunsSince} new run(s) since the last analysis (needs 5).`}
    ${optimize.canRun ? '' : `<a href="#" onclick="this.closest('div').querySelector('form').action+='&force=1';this.closest('div').querySelector('button').disabled=false;this.remove();return false">force re-run</a>`}
  </span>
</div>`
    : '';
  const insightsHtml = aiInsights
    ? `<h2>AI cost analysis <span style="font-weight:400;color:#66666e;font-size:12px">(${esc(aiInsights.provider ?? '')} ${esc(aiInsights.model)} · ${aiInsights.runsAnalyzed ?? '?'} runs analyzed · ${esc(aiInsights.generatedAt)})</span></h2>
<p style="font-size:14px">${esc(aiInsights.summary)}</p>
${aiInsights.insights
  .map(
    (i) => `<div style="background:#fff;border:1px solid #e4e4e8;border-radius:10px;padding:12px 16px;margin-bottom:10px">
  <div style="display:flex;gap:10px;align-items:center;font-size:12px;color:#66666e">
    <b style="color:#1a1a1e;font-size:14px">${esc(i.title)}</b>
    <span style="margin-left:auto;font-weight:800;color:#00794f">${usd(i.est_monthly_saving_usd)}/mo</span>
  </div>
  <div style="font-size:12px;color:#66666e;margin:2px 0 6px">${esc(i.category)} · performance risk: <b>${esc(i.performance_risk)}</b></div>
  <div style="font-size:13px">${esc(i.rationale)}</div>
  <div style="font-size:13px;color:#3c3c44;margin-top:6px"><b>Do:</b> ${esc(i.implementation)}</div>
  ${(i.evidence_runs ?? []).length ? `<div style="font-size:12px;color:#66666e;margin-top:6px">evidence: ${(i.evidence_runs ?? []).slice(0, 6).map((r) => `<a href="/g/${esc(r)}?key=${k}"><code>${esc(r.slice(0, 8))}…</code></a>`).join(' ')}</div>` : ''}
</div>`,
  )
  .join('')}`
    : `<h2>AI cost analysis</h2><p style="font-size:13px;color:#66666e">Not generated yet — <code>curl -X POST &lt;server&gt;/api/v1/insights -H 'authorization: Bearer &lt;key&gt;'</code></p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccopt — ${esc(tenantName)}</title><style>${SHELL_CSS}</style></head><body><div class="wrap">
<h1>ccopt workspace: ${esc(tenantName)}</h1>
<div class="sub">agents, sessions, and reports in this tenant${optimize?.agentFilter ? ` · filtered to <code>${esc(optimize.agentFilter)}</code> · <a href="/ui?key=${k}">clear filter</a>` : ''}</div>
${optimizeHtml}

<h2>Agents</h2>
<table><thead><tr><th>agent</th><th>runs</th><th>total cost</th><th>last seen</th></tr></thead><tbody>
${agents
  .map(
    (a) =>
      `<tr><td><code>${esc(a.agent_id)}</code></td><td>${a.n_runs}</td><td>${usd(a.total_cost_usd)}</td><td>${esc(a.last_seen ?? '—')}</td></tr>`,
  )
  .join('')}
</tbody></table>

${insightsHtml}

<h2>Reports</h2>
<table><thead><tr><th>generated</th><th>runs</th><th>observed cost</th><th></th></tr></thead><tbody>
${reports
  .map(
    (r) =>
      `<tr><td>${esc(r.generated_at)}</td><td>${r.totals.runs ?? '—'}</td><td>${r.totals.costUsd != null ? usd(r.totals.costUsd) : '—'}</td><td><a href="/r/${r.id}">open report</a></td></tr>`,
  )
  .join('')}
</tbody></table>

<h2>Recent sessions</h2>
<table><thead><tr><th>started</th><th>agent</th><th>steps</th><th>cost</th><th>session</th></tr></thead><tbody>
${runs
  .map(
    (r) =>
      `<tr><td>${esc(r.started_at ?? '—')}</td><td><code>${esc(r.agent_id)}</code></td><td>${r.n_steps}</td><td>${usd(r.cost_usd)}</td><td><a href="/s/${esc(r.session_id)}?key=${k}"><code>${esc(r.session_id.slice(0, 8))}…</code></a></td></tr>`,
  )
  .join('')}
</tbody></table>
</div></body></html>`;
}

const SESSION_CSS = `${SHELL_CSS}
  .step { background: #fff; border: 1px solid #e4e4e8; border-radius: 10px; padding: 10px 14px; margin-bottom: 10px; }
  .step .head { display: flex; gap: 10px; align-items: center; font-size: 12px; color: #66666e; margin-bottom: 6px; }
  .badge { color: #fff; font-size: 10px; font-weight: 700; letter-spacing: .05em; padding: 2px 7px; border-radius: 5px; }
  .b-user { background: #0b84ff; } .b-assistant { background: #6e6e76; }
  .b-tool { background: #7c5cff; } .b-result { background: #00a37a; } .b-error { background: #e5484d; } .b-think { background: #c9c9cf; color: #333; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; font-family: ui-monospace, Menlo, monospace; background: #f7f7f8; border-radius: 6px; padding: 8px 10px; max-height: 320px; overflow: auto; }
  details > summary { cursor: pointer; font-size: 12px; color: #55555e; }
`;

export function renderSessionHtml(
  run: Run,
  key: string,
  redact: (t: string) => string,
  revealed: boolean,
): string {
  const models = run.models.join(', ');
  const steps = run.steps
    .map((sRaw, i) => {
      const s = { ...sRaw, payload: redact(sRaw.payload) };
      if (s.kind === 'thinking') {
        return `<div class="step"><div class="head"><span class="badge b-think">THINKING</span><span>#${i}</span></div></div>`;
      }
      const badge =
        s.kind === 'tool_use'
          ? `<span class="badge b-tool">TOOL ${esc(s.name)}</span>`
          : s.kind === 'tool_result'
            ? `<span class="badge ${s.isError ? 'b-error' : 'b-result'}">${s.isError ? 'ERROR' : 'RESULT'} ${esc(s.name)}</span>`
            : `<span class="badge b-${s.name === 'user' ? 'user' : 'assistant'}">${esc(s.name.toUpperCase())}</span>`;
      const body =
        s.payload.length > 1500
          ? `<details><summary>${s.payload.length.toLocaleString()} chars — expand</summary><pre>${esc(s.payload)}</pre></details><pre>${esc(s.payload.slice(0, 1500))}…</pre>`
          : `<pre>${esc(s.payload)}</pre>`;
      return `<div class="step"><div class="head">${badge}<span>#${i}</span><span>${esc(s.timestamp ?? '')}</span></div>${body}</div>`;
    })
    .join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccopt session ${esc(run.runId.slice(0, 8))}</title><style>${SESSION_CSS}</style></head><body><div class="wrap">
<h1>Session <code>${esc(run.runId)}</code></h1>
<div class="sub">agent <code>${esc(run.agentId)}</code> · ${esc(run.startedAt ?? '')} · ${run.steps.length} steps · ${usd(run.costUsd)} · ${esc(models)}
 · <a href="/ui?key=${encodeURIComponent(key)}">← dashboard</a></div>
<div style="background:${revealed ? '#fdecec' : '#fff8e8'};border:1px solid ${revealed ? '#e5484d' : '#eedc9a'};border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:14px">
${revealed
  ? '<b>Revealed:</b> raw content including any secrets. <a href="?key=' + encodeURIComponent(key) + '">back to redacted view</a>'
  : '<b>Protected view:</b> credential-shaped values are redacted. <a href="?key=' + encodeURIComponent(key) + '&reveal=1">reveal raw content</a> (owner only)'}
</div>
${steps}
</div></body></html>`;
}

// ─── Graph view: the canonical DAG + full I/O per node ───────────────────────

const GRAPH_CSS = `${SHELL_CSS}
  .graph-scroll { overflow: auto; background: #fff; border: 1px solid #e4e4e8; border-radius: 10px; padding: 8px; }
  .node-card { background: #fff; border: 1px solid #e4e4e8; border-radius: 10px; padding: 10px 14px; margin-bottom: 8px; }
  .node-card .head { font-size: 12px; color: #66666e; margin-bottom: 4px; }
  pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; font-size: 11px; font-family: ui-monospace, Menlo, monospace; background: #f7f7f8; border-radius: 6px; padding: 7px 9px; max-height: 260px; overflow: auto; }
  details > summary { cursor: pointer; font-size: 12px; color: #55555e; }
  .legend { font-size: 12px; color: #66666e; margin: 8px 0 14px; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin: 0 4px 0 12px; vertical-align: -1px; }
`;

export function renderGraphHtml(
  graph: RunGraph,
  key: string,
  redact: (t: string) => string,
  revealed: boolean,
): string {
  const k = encodeURIComponent(key);
  const dataflowCount = graph.edges.filter((e) => e.type === 'dataflow').length;
  const nodeCards = graph.nodes
    .map((nRaw) => {
      const n = { ...nRaw, canonicalValue: redact(nRaw.canonicalValue), raw: redact(nRaw.raw) };
      return `<div class="node-card" id="node-${n.index}">
  <div class="head">#${n.index} · <b>${esc(n.kind)}</b>${n.isError ? ' · <b style="color:#e5484d">error</b>' : ''}</div>
  <div style="font-size:12px"><code>${esc(n.label)}</code></div>
  ${n.canonicalValue ? `<details><summary>canonical I/O (what L0 hashes)</summary><pre>${esc(n.canonicalValue)}</pre></details>` : ''}
  ${n.raw ? `<details><summary>raw payload</summary><pre>${esc(n.raw)}</pre></details>` : ''}
</div>`;
    })
    .join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>graph ${esc(graph.runId.slice(0, 8))}</title><style>${GRAPH_CSS}</style></head><body><div class="wrap">
<h1>Run graph <code>${esc(graph.runId)}</code></h1>
<div class="sub">agent <code>${esc(graph.agentId)}</code> · ${graph.nodes.length} nodes · ${dataflowCount} dataflow edge(s) · ${usd(graph.costUsd)}
 · L1 <code>${esc(graph.l1.slice(0, 12))}</code> · <a href="/s/${esc(graph.runId)}?key=${k}">transcript</a> · <a href="/ui?key=${k}">dashboard</a></div>
<div style="background:${revealed ? '#fdecec' : '#fff8e8'};border:1px solid ${revealed ? '#e5484d' : '#eedc9a'};border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:10px">
${revealed
  ? '<b>Revealed:</b> raw content including any secrets. <a href="?key=' + k + '">back to redacted view</a>'
  : '<b>Protected view:</b> credential-shaped values are redacted. <a href="?key=' + k + '&reveal=1">reveal raw content</a> (owner only)'}
</div>
<div class="legend">
  <span class="sw" style="background:#eef2ff;border:1px solid #7c5cff"></span> tool call
  <span class="sw" style="background:#f0faf5;border:1px solid #00a37a"></span> tool result
  <span class="sw" style="background:#f7f7f8;border:1px solid #9a9aa2"></span> model turn
  <span class="sw" style="background:#fdecec;border:1px solid #e5484d"></span> error
  — colored arcs on the right are <b>dataflow</b>: an output feeding a later input (click a node for its I/O)
</div>
<div class="graph-scroll">${runGraphSvg(graph)}</div>
<h2>Nodes — canonical label, canonical I/O, raw payload</h2>
${nodeCards}
</div></body></html>`;
}

// ─── Cluster view: the money page ────────────────────────────────────────────

export interface ClusterViewData {
  clusterKey: string;
  agentId: string;
  nRuns: number;
  totalCostUsd: string;
  determinism: string;
  metrics: {
    costP50Usd?: number;
    costP95Usd?: number;
    failureRate?: number;
    retrySubchains?: number;
    modelMix?: Record<string, number>;
    volatileSlots?: VolatileSlot[];
    l0DuplicateRuns?: number;
    cacheReadRatio?: number;
  };
  labelSequence: string[];
  sessions: { session_id: string; started_at: string | Date | null; cost_usd: string }[];
  findings: { kind: string; title: string; est_monthly_saving_usd: string; payload: { recommendation?: string } }[];
}

export function renderClusterHtml(c: ClusterViewData, key: string): string {
  const k = encodeURIComponent(key);
  const m = c.metrics;
  const slots = m.volatileSlots ?? [];
  const det = Number(c.determinism);
  const verdict =
    det >= 0.9
      ? `<b style="color:#00794f">deterministic procedure</b> — everything outside the volatile slots repeats; prime compile/cache candidate`
      : det >= 0.6
        ? `<b style="color:#a86500">mostly deterministic</b> — inspect the varying steps before compiling`
        : `<b style="color:#e5484d">low determinism</b> — outputs or paths vary; not a compile candidate yet`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cluster ${esc(c.clusterKey.slice(0, 20))}</title><style>${GRAPH_CSS}</style></head><body><div class="wrap">
<h1>Procedure cluster</h1>
<div class="sub">agent <code>${esc(c.agentId)}</code> · ${c.nRuns} run(s) · total ${usd(c.totalCostUsd)} ·
 determinism ${(det * 100).toFixed(0)}% · <a href="/ui?key=${k}">dashboard</a></div>

<p style="font-size:14px">${verdict}. Failure rate ${((m.failureRate ?? 0) * 100).toFixed(0)}% ·
 ${m.retrySubchains ?? 0} retry sub-chain(s) · ${m.l0DuplicateRuns ?? 0} exact duplicate run(s) ·
 cache-read ratio ${((m.cacheReadRatio ?? 0) * 100).toFixed(0)}% ·
 p50 ${usd(m.costP50Usd ?? 0)} / p95 ${usd(m.costP95Usd ?? 0)} per run ·
 models: ${Object.entries(m.modelMix ?? {}).map(([mm, n]) => `${esc(mm.replace('claude-', ''))}×${n}`).join(', ') || '—'}</p>

${c.findings.length ? `<h2>What to do (dollar-ranked)</h2>` : ''}
${c.findings
  .map(
    (f) => `<div class="node-card"><div class="head"><b>${esc(f.kind.toUpperCase())}</b> · est ${usd(f.est_monthly_saving_usd)}/mo</div>
    <div style="font-size:13px">${esc(f.title)}</div>
    ${f.payload?.recommendation ? `<div style="font-size:13px;color:#3c3c44;margin-top:4px">${esc(f.payload.recommendation)}</div>` : ''}</div>`,
  )
  .join('\n')}

<h2>The procedure shape (${c.labelSequence.length} canonical steps)</h2>
<div class="sub">every run in this cluster followed exactly these steps — only the volatile slots below changed</div>
<div class="graph-scroll">${chainList(c.labelSequence)}</div>

<h2>Volatile slots — the parameters (${slots.length})</h2>
<div class="sub">these positions vary across runs: they are the inputs a compiled script/cache key must keep. Everything else is repetition you are re-paying for.</div>
<table><thead><tr><th>step</th><th>label</th><th>distinct values</th><th>examples</th></tr></thead><tbody>
${slots
  .map(
    (s) =>
      `<tr><td>#${s.nodeIndex}</td><td><code>${esc(s.label)}</code></td><td>${s.distinctValues}</td><td><code>${s.examples.map((e) => esc(e.slice(0, 60))).join('</code><br><code>')}</code></td></tr>`,
  )
  .join('')}
</tbody></table>

<h2>Evidence runs</h2>
<table><thead><tr><th>started</th><th>cost</th><th>session</th><th>graph</th></tr></thead><tbody>
${c.sessions
  .map(
    (s) =>
      `<tr><td>${esc(s.started_at)}</td><td>${usd(s.cost_usd)}</td><td><a href="/s/${esc(s.session_id)}?key=${k}"><code>${esc(s.session_id.slice(0, 8))}…</code></a></td><td><a href="/g/${esc(s.session_id)}?key=${k}">view graph</a></td></tr>`,
  )
  .join('')}
</tbody></table>
</div></body></html>`;
}

function chainList(labels: string[]): string {
  return `<ol style="font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.9;margin:6px 0;padding-left:34px">${labels
    .map((l) => `<li>${esc(l.length > 110 ? l.slice(0, 109) + '…' : l)}</li>`)
    .join('')}</ol>`;
}
