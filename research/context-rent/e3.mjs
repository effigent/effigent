// E3 — (a) how often does a task boundary carry a real dependency? (b) what does a FRESH start cost?
import fs from 'node:fs'; import { episodes, isFollowUp, isExplore } from './lib.mjs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
let bounds = 0, followUp = 0, pathDep = 0, independent = 0;
const firstEp = [], laterEp = []; const depCurve = {};
for (const s of ds) { const E = episodes(s); const seen = new Set();
  E.forEach((e, idx) => {
    // exploration overhead: exploratory calls before the first write/edit/side-effect, in tokens of context growth
    let explTok = 0, explCalls = 0; for (let k = 0; k < e.reqs.length; k++) { const r = e.reqs[k]; if (!r.tools.length) continue; if (!r.tools.every((t) => isExplore(t.action))) break; explCalls += r.tools.length; explTok += (e.reqs[k + 1]?.ctx ?? r.ctx) - r.ctx; }
    const rec = { explCalls, explTok, reqs: e.reqs.length, followUp: isFollowUp(e.ask) };
    if (idx === 0) firstEp.push(rec); else if (!rec.followUp) laterEp.push({ ...rec, overlap: [...e.paths].filter((p) => seen.has(p)).length / Math.max(1, e.paths.size), hasPaths: e.paths.size > 0 });
    if (idx > 0) { bounds++; const fu = isFollowUp(e.ask); const ov = [...e.paths].some((p) => seen.has(p)); if (fu) followUp++; else if (ov) pathDep++; else independent++; }
    for (const p of e.paths) seen.add(p);
  }); }
console.log('task boundaries', bounds, ' follow-up (leans on conversation)', followUp, ` (${(100 * followUp / bounds).toFixed(0)}%)`, ' new ask touching earlier files', pathDep, ` (${(100 * pathDep / bounds).toFixed(0)}%)`, ' new ask, no shared files', independent, ` (${(100 * independent / bounds).toFixed(0)}%)`);
const stat = (arr, k) => { const v = arr.map((x) => x[k]).sort((a, b) => a - b); return { n: v.length, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1), p50: v[v.length >> 1], p90: v[Math.floor(v.length * .9)] }; };
console.log('\nexploration before first action — FIRST episode of a session (fresh context):', stat(firstEp.filter((x) => !x.followUp), 'explCalls'), 'tokens', stat(firstEp.filter((x) => !x.followUp), 'explTok'));
const indep = laterEp.filter((x) => x.hasPaths && x.overlap === 0), dep = laterEp.filter((x) => x.overlap > 0);
console.log('                                  — later, NEW ask, no shared files (warm):     ', stat(indep, 'explCalls'), 'tokens', stat(indep, 'explTok'));
console.log('                                  — later, NEW ask, shares files (warm):        ', stat(dep, 'explCalls'), 'tokens', stat(dep, 'explTok'));
