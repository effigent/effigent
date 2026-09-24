// What the CURRENT Insights view tells a user, per agent — same engine calls + same verdict gates as the route.
import fs from 'node:fs'; import path from 'node:path';
import * as E from '../../packages/core/dist/index.js';
const root = process.env.HOME + '/.claude/projects'; const byAgent = {};
for (const d of fs.readdirSync(root)) { const dir = path.join(root, d); if (!fs.statSync(dir).isDirectory()) continue;
  const agent = d.replace(/^-(Users|home)-[^-]+-?/, '').replace(/^(Documents-private-|Documents-|Projects-)/, '') || 'home';
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) { const r = E.parseTranscript(fs.readFileSync(path.join(dir, f), 'utf8'), { agentId: agent }); if (r) (byAgent[agent] ??= []).push(r); } }
for (const agent of Object.keys(byAgent).sort((a, b) => byAgent[b].length - byAgent[a].length).slice(0, 3)) {
  const runs = byAgent[agent].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, 40); const graphs = runs.map(E.buildRunGraph);
  console.log(`\n=== ${agent} (${runs.length} runs)`);
  const seg = E.mineSegments(graphs).slice(0, 5); for (const s of seg) { const act = s.determinism >= 0.9 && s.separability === 'clean' ? 'COMPILE' : s.mechanicalRatio >= 0.5 && s.separability !== 'entangled' ? 'ROUTE to smaller model' : 'EXTRACT as sub-agent'; console.log(`  segment  ${act.padEnd(22)} ${s.labels.join(' → ').slice(0, 90)}  det=${s.determinism.toFixed(2)} $${s.totalCostUsd.toFixed(0)}`); }
  const sub = E.mineSubtrees(graphs).slice(0, 3); for (const s of sub) { const act = s.confidence >= 0.6 && s.determinism >= 0.9 ? 'COMPILE' : s.mechanicalRatio >= 0.5 ? 'ROUTE' : 'REVIEW'; console.log(`  subtree  ${act.padEnd(22)} ${s.labels.slice(0, 5).join(' , ').slice(0, 90)} $${s.totalCostUsd.toFixed(0)}`); }
  for (const s of E.suggestTools(graphs).slice(0, 3)) console.log(`  "deterministic savings"  ${s.actions.join(' → ').slice(0, 80)}  glue $${s.glueCostUsd.toFixed(2)}`);
  const mix = {}; for (const g of graphs) for (const e of E.segmentEpisodes(g)) mix[e.intent] = (mix[e.intent] ?? 0) + e.costUsd; const tm = Object.values(mix).reduce((a, b) => a + b, 0);
  console.log('  task mix', Object.entries(mix).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(100 * v / tm).toFixed(0)}%`).join(' · '));
  const L = E.aggregateLedgers(runs.map((r, i) => E.computeRunLedger(r, graphs[i]))); console.log('  old ledger', Object.entries(L.slices).map(([k, v]) => `${k} $${v.toFixed(0)}`).join(' · '));
  const an = E.analyzeDeterminism(graphs, { threshold: 0.75 }); console.log('  clusters', an.length, 'tools', E.synthesizeTools(an).length);
}
