// The NEW OUTPUT: runs core's analyzeAgent (the code path the Insights route uses) over local transcripts,
// grouped by project like the CLI's attribution, last 40 sessions per agent. Writes plan-output.json.
import fs from 'node:fs'; import path from 'node:path';
import { parseTranscript, analyzeAgent } from '../../packages/core/dist/index.js';
const root = process.env.HOME + '/.claude/projects'; const WINDOW = Number(process.argv[2] ?? 40);
const byAgent = {};
for (const d of fs.readdirSync(root)) { const dir = path.join(root, d); if (!fs.statSync(dir).isDirectory()) continue;
  const agent = d.replace(/^-(Users|home)-[^-]+-?/, '').replace(/^(Documents-private-|Documents-|Projects-)/, '') || 'home';
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) { const r = parseTranscript(fs.readFileSync(path.join(dir, f), 'utf8'), { agentId: agent }); if (r) (byAgent[agent] ??= []).push(r); } }
const out = [];
for (const [agent, runs] of Object.entries(byAgent)) { if (runs.length < 3) continue;
  runs.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')); const w = runs.slice(0, WINDOW);
  const t0 = Date.now(); const a = analyzeAgent(agent, w); a.ms = Date.now() - t0; out.push(a); }
out.sort((a, b) => b.costUsd - a.costUsd);
fs.writeFileSync(new URL('./plan-output.json', import.meta.url), JSON.stringify(out, null, 1));
for (const a of out) {
  console.log(`\n■ ${a.agentId} — ${a.runs} sessions, $${a.costUsd.toFixed(0)}  (rent calibration ${a.calibration.toFixed(3)}, ${a.ms}ms)`);
  const s = a.spend; const T = a.costUsd / 100; console.log(`  spend: reads ${(s.cacheReadUsd / T).toFixed(0)}% · writes ${(s.cacheWriteUsd / T).toFixed(0)}% · side-model ${(s.sideModelUsd / T).toFixed(0)}% · output ${((s.outputUsd + s.thinkingUsd) / T).toFixed(0)}%   cold rewrites ${a.coldRewrites.count} ($${a.coldRewrites.penaltyUsd.toFixed(0)})   CLAUDE.md ${Math.round(a.instructionsTokens / 1000)}k tok`);
  for (const p of a.plan) console.log(`  ▸ [${p.basis}] ${p.title}${p.savingsUsd ? `  → $${p.savingsUsd.low.toFixed(0)}–$${p.savingsUsd.high.toFixed(0)}` : ''}${p.files.length ? `  [${p.files.map((f) => f.path).join(', ')}]` : ''}`);
}
