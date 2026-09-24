// What a person reads first: summarizeAgent over each agent's last 40 local sessions (terminal).
import fs from 'node:fs'; import path from 'node:path';
import { parseTranscript, analyzeAgent, summarizeAgent } from '../../packages/core/dist/index.js';
const root = process.env.HOME + '/.claude/projects'; const byAgent = {};
for (const d of fs.readdirSync(root)) { const dir = path.join(root, d); if (!fs.statSync(dir).isDirectory()) continue;
  const agent = d.replace(/^-(Users|home)-[^-]+-?/, '').replace(/^(Documents-private-|Documents-|Projects-)/, '') || 'home';
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) { const r = parseTranscript(fs.readFileSync(path.join(dir, f), 'utf8'), { agentId: agent }); if (r) (byAgent[agent] ??= []).push(r); } }
const $ = (v) => '$' + (v >= 10 ? Math.round(v).toLocaleString() : v.toFixed(2));
for (const [agent, runs] of Object.entries(byAgent).sort((a, b) => b[1].length - a[1].length)) { if (runs.length < 4) continue;
  const w = runs.sort((x, y) => (y.startedAt ?? '').localeCompare(x.startedAt ?? '')).slice(0, 40); const s = summarizeAgent(analyzeAgent(agent, w), w);
  console.log(`\n━━ ${agent}\n   ${s.headline}`);
  console.log('   DO THIS FIRST'); for (const x of s.actions.slice(0, 4)) console.log(`     • ${x.title}${x.perMonthUsd ? `  ≈${$(x.perMonthUsd.low)}–${$(x.perMonthUsd.high)}/mo` : ''} [${x.basis}]  — ${x.why.slice(0, 150)}`);
  console.log('   FINDINGS'); for (const f of s.findings) console.log(`     [${f.severity}] ${f.value.padEnd(8)} ${f.title}`);
  console.log('   SESSIONS'); for (const e of s.sessions) console.log(`     ${$(e.costUsd).padStart(5)} "${(e.title ?? e.runId).slice(0, 44)}" ${e.requestsX.toFixed(1)}× median length · peak ${Math.round(e.peakContext / 1000)}k · ${e.delivered ? 'delivered' : 'no commit/push'}${e.compactionSavesUsd != null ? ` · compacting would have saved ${$(e.compactionSavesUsd)}` : ''}`);
  console.log('   TREND ' + s.trend.weeks.map((x) => `${x.week.slice(5)}:$${x.costPerRequest.toFixed(2)}/req·${Math.round(x.baseTokens / 1000)}k base`).join('  '));
}
