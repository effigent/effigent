// E4 — natural experiment: the 26 real compactions. What does context look like before/after,
// and does the agent re-explore (re-acquisition) after losing its history?
import fs from 'node:fs'; import { isExplore } from './lib.mjs';
const ds = JSON.parse(fs.readFileSync(process.argv[2])); const rows = [];
for (const s of ds) for (const e of s.ev.filter((x) => x.t === 'compact')) {
  const k = s.reqs.findIndex((r) => r.ts > e.ts); if (k < 1) continue;
  const before = s.reqs[k - 1].ctx, after = s.reqs[k].ctx;
  let expl = 0, calls = 0; for (let j = k; j < Math.min(s.reqs.length, k + 12); j++) { const r = s.reqs[j]; if (!r.tools.length) continue; calls += r.tools.length; expl += r.tools.filter((t) => isExplore(t.action)).length; }
  // baseline explore rate in the 12 requests BEFORE compaction
  let bE = 0, bC = 0; for (let j = Math.max(0, k - 12); j < k; j++) { const r = s.reqs[j]; bC += r.tools.length; bE += r.tools.filter((t) => isExplore(t.action)).length; }
  rows.push({ sid: s.sid.slice(0, 8), trigger: e.trigger, preTok: e.pre, ctxBefore: before, ctxAfter: after, exploreShareAfter: +(expl / Math.max(1, calls)).toFixed(2), exploreShareBefore: +(bE / Math.max(1, bC)).toFixed(2) });
}
console.table(rows);
const m = (k) => (rows.reduce((a, r) => a + r[k], 0) / rows.length).toFixed(2);
console.log('mean explore share: before', m('exploreShareBefore'), 'after', m('exploreShareAfter'), ' mean ctx before', m('ctxBefore'), 'after', m('ctxAfter'));
