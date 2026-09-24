// The new Insights output, per agent, in the terminal — analyzeAgent over each agent's last 40 local sessions.
import fs from 'node:fs'; import path from 'node:path';
import { parseTranscript, analyzeAgent } from '../../packages/core/dist/index.js';
const root = process.env.HOME + '/.claude/projects'; const byAgent = {};
for (const d of fs.readdirSync(root)) { const dir = path.join(root, d); if (!fs.statSync(dir).isDirectory()) continue;
  const agent = d.replace(/^-(Users|home)-[^-]+-?/, '').replace(/^(Documents-private-|Documents-|Projects-)/, '') || 'home';
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) { const r = parseTranscript(fs.readFileSync(path.join(dir, f), 'utf8'), { agentId: agent }); if (r) (byAgent[agent] ??= []).push(r); } }
const $ = (v) => '$' + (v >= 10 ? Math.round(v).toLocaleString() : v.toFixed(2)); const P = (v) => Math.round(100 * v) + '%';
for (const [agent, runs] of Object.entries(byAgent).sort((a, b) => b[1].length - a[1].length)) { if (runs.length < 4) continue;
  const a = analyzeAgent(agent, runs.sort((x, y) => (y.startedAt ?? '').localeCompare(x.startedAt ?? '')).slice(0, 40)); const L = a.laws;
  const s = a.spend, T = a.costUsd;
  console.log(`\n━━ ${agent} · ${a.runs} sessions · ${$(T)}`);
  console.log(`   money paid for: re-reading ${P(s.cacheReadUsd / T)} · writing ${P((s.cacheWriteUsd + s.uncachedUsd) / T)} · advisor ${P(s.sideModelUsd / T)} · generating ${P((s.outputUsd + s.thinkingUsd) / T)}`);
  console.log(`   requests were for: ${L.reasons.slice(0, 5).map((r) => `${r.reason} ${P(r.share)} @${Math.round(r.avgContext / 1000)}k`).join(' · ')}`);
  if (L.law) console.log(`   law: cost ∝ length² (R² ${L.law.fitR2.toFixed(2)}) · base ${Math.round(L.law.baseTokens / 1000)}k · +${L.law.depositPerRequest}/request · ${P(L.law.aboveThresholdShare)} of re-reading above EOQ ${L.law.eoqThreshold / 1000}k`);
  if (L.drivers) console.log(`   sessions differ by: length ${P(L.drivers.requests)} · context ${P(L.drivers.context)}`);
  const d = a.determinism; if (d.reason) console.log(`   determinism (held-out, ${d.reason.testSessions} later sessions): ${P(d.reason.coverage80)} of next steps predictable at ≥80% (${P(d.reason.precision80)} right) · ${P(d.reason.spendShare80)} of spend · exact actions ${d.action ? P(d.action.coverage80) : 'n/a'} · history explains ${P(d.reason.explained)} of uncertainty`);
  const o = L.outcomes; if (o.coverage) console.log(`   delivered: ${o.commits} commits · ${o.pushes} pushes · ${o.prs} PR actions in ${o.deliveringSessions}/${L.runs} sessions${o.costPerDeliveringSessionUsd != null ? ` · ${$(o.costPerDeliveringSessionUsd)} per delivering session` : ''} · ${o.denials} denied calls`);
  for (const e of L.expensive) console.log(`   ${$(e.costUsd).padStart(5)} "${(e.title ?? e.runId).slice(0, 46)}" ${e.requestsX.toFixed(1)}× requests · ${e.contextX.toFixed(1)}× context · ${P(e.topReasonShare)} ${e.topReason}${e.delivered ? ' · delivered' : ' · no commit/push'}`);
  for (const p of a.plan) console.log(`   ▸ [${p.basis}] ${p.title}${p.savingsUsd ? `  ${$(p.savingsUsd.low)}–${$(p.savingsUsd.high)}` : ''}`);
  console.log(`   loop: ${a.loop.length ? a.loop.map((o) => `${o.lever} ${o.status}`).join(', ') : 'no proposed change adopted yet'}`);
}
