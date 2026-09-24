// End-to-end check of the ENGINE (not the research scripts): parseTranscript → computeRentLedger / recommendCompaction.
import fs from 'node:fs'; import path from 'node:path';
import { parseTranscript, computeRentLedger, recommendCompaction } from '../../packages/core/dist/index.js';
const root = process.env.HOME + '/.claude/projects'; const runs = [];
for (const d of fs.readdirSync(root)) { const dir = path.join(root, d); if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) { const r = parseTranscript(fs.readFileSync(path.join(dir, f), 'utf8'), { agentId: d }); if (r) runs.push(r); } }
const L = runs.map((r) => computeRentLedger(r));
const sum = (f) => L.reduce((s, l) => s + f(l), 0);
const reads = sum((l) => l.spend.cacheReadUsd), rent = sum((l) => l.rent.baseUsd + Object.values(l.rent.byKind).reduce((a, b) => a + b, 0));
console.log(`runs ${runs.length}  cost $${sum((l) => l.costUsd).toFixed(0)}  reads $${reads.toFixed(0)}  rent $${rent.toFixed(0)}  calibration ${(rent / reads).toFixed(4)}`);
console.log('spend', Object.fromEntries(Object.entries(L[0].spend).map(([k]) => [k, +sum((l) => l.spend[k]).toFixed(0)])));
console.log('rent  base', sum((l) => l.rent.baseUsd).toFixed(0), Object.fromEntries(Object.keys(L[0].rent.byKind).map((k) => [k, +sum((l) => l.rent.byKind[k]).toFixed(0)])), 'cold rewrites', sum((l) => l.coldRewrites.count), '$' + sum((l) => l.coldRewrites.penaltyUsd).toFixed(0));
const cals = L.filter((l) => l.spend.cacheReadUsd > 1).map((l) => l.calibration).sort((a, b) => a - b); console.log('per-run calibration p5', cals[Math.floor(cals.length * .05)].toFixed(3), 'p50', cals[cals.length >> 1].toFixed(3), 'p95', cals[Math.floor(cals.length * .95)].toFixed(3));
const t0 = Date.now(); const rec = recommendCompaction(runs); console.log(`\nrecommendation (${Date.now() - t0}ms): compact at ${rec.threshold}  observed $${rec.observedUsd.toFixed(0)} calibrated $${rec.calibratedUsd.toFixed(0)}`, rec.savingsUsd.map((s) => `${s.scenario}:$${s.usd.toFixed(0)}`).join(' '));
for (const s of rec.sweep) console.log('  ', s.threshold, Object.entries(s.savingsUsd).map(([k, v]) => `${k} $${v.toFixed(0)}`).join('  '), 'compactions', s.compactions);
// per project (agent)
const byA = {}; for (const r of runs) (byA[r.agentId] ??= []).push(r);
for (const [a, rs] of Object.entries(byA)) { if (rs.length < 3) continue; const x = recommendCompaction(rs); console.log(a.replace(/^-(Users|home)-[^-]+-?/, '').padEnd(32), 'runs', rs.length, 'T', x.threshold, 'worst-case save $' + (x.savingsUsd[0]?.usd ?? 0).toFixed(0), 'of $' + x.observedUsd.toFixed(0)); }
