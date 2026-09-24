// Runs computeLaws + evaluateLoop (engine) over local transcripts per agent (all sessions, chronological).
import fs from 'node:fs'; import path from 'node:path';
import { parseTranscript, computeLaws, evaluateLoop } from '../../packages/core/dist/index.js';
const root = process.env.HOME + '/.claude/projects'; const byAgent = {};
for (const d of fs.readdirSync(root)) { const dir = path.join(root, d); if (!fs.statSync(dir).isDirectory()) continue;
  const agent = d.replace(/^-(Users|home)-[^-]+-?/, '').replace(/^(Documents-private-|Documents-|Projects-)/, '') || 'home';
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) { const r = parseTranscript(fs.readFileSync(path.join(dir, f), 'utf8'), { agentId: agent }); if (r) (byAgent[agent] ??= []).push(r); } }
const $ = (v) => '$' + v.toFixed(v < 10 ? 2 : 0);
for (const [agent, runs] of Object.entries(byAgent)) { if (runs.length < 4) continue;
  const L = computeLaws(runs.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, 40));
  console.log(`\n■ ${agent} (${L.runs} sessions)`);
  console.log('  spent on: ' + L.reasons.slice(0, 6).map((r) => `${r.reason} ${(100 * r.share).toFixed(0)}% (@${Math.round(r.avgContext / 1000)}k)`).join(' · '));
  if (L.law) console.log(`  law: base ${Math.round(L.law.baseTokens / 1000)}k + ${L.law.depositPerRequest} tok/request · fit R²=${L.law.fitR2.toFixed(2)} · EOQ compact at ${L.law.eoqThreshold / 1000}k (one compaction ≈ ${$(L.law.compactionCostUsd)}) · ${(100 * L.law.aboveThresholdShare).toFixed(0)}% of re-reading happens above it`);
  if (L.drivers) console.log(`  cost differences between sessions: length ${(100 * L.drivers.requests).toFixed(0)}% · context ${(100 * L.drivers.context).toFixed(0)}% · price ${(100 * L.drivers.price).toFixed(0)}%`);
  for (const e of L.expensive) console.log(`  ${$(e.costUsd).padStart(6)} "${(e.title ?? e.runId).slice(0, 44)}" — ${e.requestsX.toFixed(1)}× requests, ${e.contextX.toFixed(1)}× context vs median; ${(100 * e.topReasonShare).toFixed(0)}% on ${e.topReason}`);
  for (const o of evaluateLoop(runs)) console.log(`  loop: ${o.lever} adopted ${o.adoptedAt.slice(0, 10)} → ${o.status} (${o.metric} ${Math.round(o.metricBefore)} → ${Math.round(o.metricAfter)}, $/req ${o.costPerRequestBefore.toFixed(3)} → ${o.costPerRequestAfter.toFixed(3)}, n=${o.before}/${o.after}, quality ${o.qualityOk ? 'ok' : 'WORSE'})`);
}
