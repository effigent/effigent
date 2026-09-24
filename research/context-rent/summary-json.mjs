// Writes the summaries (engine output) for local agents to a JSON file — input for a UI preview.
import fs from 'node:fs'; import path from 'node:path';
import { parseTranscript, analyzeAgent, summarizeAgent } from '../../packages/core/dist/index.js';
const root = process.env.HOME + '/.claude/projects'; const byAgent = {};
for (const d of fs.readdirSync(root)) { const dir = path.join(root, d); if (!fs.statSync(dir).isDirectory()) continue;
  const agent = d.replace(/^-(Users|home)-[^-]+-?/, '').replace(/^(Documents-private-|Documents-|Projects-)/, '') || 'home';
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) { const r = parseTranscript(fs.readFileSync(path.join(dir, f), 'utf8'), { agentId: agent }); if (r) (byAgent[agent] ??= []).push(r); } }
const out = {}; for (const [a, runs] of Object.entries(byAgent)) { if (runs.length < 8) continue; const w = runs.sort((x, y) => (y.startedAt ?? '').localeCompare(x.startedAt ?? '')).slice(0, 40); out[a] = summarizeAgent(analyzeAgent(a, w), w); }
fs.writeFileSync(process.argv[2], JSON.stringify(out));
