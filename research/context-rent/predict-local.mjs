import fs from 'node:fs'; import path from 'node:path';
import { parseTranscript, measurePredictability } from '../../packages/core/dist/index.js';
const root = process.env.HOME + '/.claude/projects'; const byAgent = {};
for (const d of fs.readdirSync(root)) { const dir = path.join(root, d); if (!fs.statSync(dir).isDirectory()) continue;
  const agent = d.replace(/^-(Users|home)-[^-]+-?/, '').replace(/^(Documents-private-|Documents-|Projects-)/, '') || 'home';
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) { const r = parseTranscript(fs.readFileSync(path.join(dir, f), 'utf8'), { agentId: agent }); if (r) (byAgent[agent] ??= []).push(r); } }
const P = (v) => (100 * v).toFixed(1) + '%';
for (const [agent, runs] of Object.entries(byAgent)) for (const alpha of ['reason', 'action']) { const p = measurePredictability(runs, alpha); if (!p) continue;
  console.log(`${agent.padEnd(22)} ${alpha.padEnd(6)} test ${p.testDecisions} decisions (${p.trainSessions}→${p.testSessions} sessions) · @0.7 ${P(p.coverage70)} at ${P(p.precision70)} · @0.8 ${P(p.coverage80)} at ${P(p.precision80)} · spend ${P(p.spendShare80)} · explained ${P(p.explained)}`); }
