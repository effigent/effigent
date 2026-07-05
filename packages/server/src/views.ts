/**
 * Browser views: /ui (workspace dashboard) and /s/:sessionId (transcript viewer,
 * rendered from the raw S3 blob — full fidelity, not the trimmed DB copy).
 * Auth for browsers: ?key=cck_… query param (same tenant API key as the CLI).
 */

import type { Run } from '@ccopt/core';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function usd(n: number | string): string {
  const v = typeof n === 'string' ? Number(n) : n;
  return `$${v.toFixed(2)}`;
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
  last_seen: string | null;
}
export interface RunRow {
  session_id: string;
  agent_id: string;
  started_at: string | null;
  cost_usd: string;
  n_steps: number;
}
export interface ReportRow {
  id: string;
  generated_at: string;
  totals: { runs?: number; costUsd?: number };
}

export function renderDashboardHtml(
  tenantName: string,
  agents: AgentRow[],
  runs: RunRow[],
  reports: ReportRow[],
  key: string,
): string {
  const k = encodeURIComponent(key);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccopt — ${esc(tenantName)}</title><style>${SHELL_CSS}</style></head><body><div class="wrap">
<h1>ccopt workspace: ${esc(tenantName)}</h1>
<div class="sub">agents, sessions, and reports in this tenant</div>

<h2>Agents</h2>
<table><thead><tr><th>agent</th><th>runs</th><th>total cost</th><th>last seen</th></tr></thead><tbody>
${agents
  .map(
    (a) =>
      `<tr><td><code>${esc(a.agent_id)}</code></td><td>${a.n_runs}</td><td>${usd(a.total_cost_usd)}</td><td>${esc(a.last_seen ?? '—')}</td></tr>`,
  )
  .join('')}
</tbody></table>

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

export function renderSessionHtml(run: Run, key: string): string {
  const models = run.models.join(', ');
  const steps = run.steps
    .map((s, i) => {
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
${steps}
</div></body></html>`;
}
