// E7 — EPISODE-level determinism: ask → program. For each held-out episode, find past episodes (same
// project) whose ask is similar; predict the program (ordered set of non-exploratory action families);
// score exact-program match. This is the "slash command / skill" opportunity: a recurring intent that
// always expands to the same program.
import fs from 'node:fs'; import { episodes, isExplore, isFollowUp } from './lib.mjs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const STOP = new Set('the a an and or to of in on for it is this that please we i you me my can do be with it\'s its are was so all'.split(' '));
const words = (t) => new Set(t.toLowerCase().replace(/<[^>]+>/g, ' ').match(/[a-z֐-׿]{2,}/g)?.filter((w) => !STOP.has(w)) ?? []);
const jac = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / Math.max(1, a.size + b.size - i); };
const program = (e) => { const out = []; for (const t of e.tools) { if (isExplore(t.action)) continue; const f = t.action.split('+').map((x) => x.split(':').slice(0, 2).join(':')).filter((x) => !/^(grep|head|sed|cat|tail|awk|wc|ls|echo)$/.test(x)).join('+') || t.action; if (out[out.length - 1] !== f) out.push(f); } return out.join(' → '); };
const byP = {}; for (const s of ds) (byP[s.project] ??= []).push(s);
let total = 0, totalCost = 0; const T = [0.4, 0.6, 0.8]; const hit = T.map(() => ({ n: 0, ok: 0, cost: 0, ex: new Map() }));
for (const [p, sess] of Object.entries(byP)) { const hist = [];
  sess.forEach((s, si) => { const E = episodes(s).filter((e) => e.ask && e.tools.length);
    for (const e of E) { const w = words(e.ask); const prog = program(e); if (si >= Math.floor(sess.length * 0.7) && w.size) { total++; totalCost += e.cost;
        let best = null; for (const h of hist) { const j = jac(w, h.w); if (!best || j > best.j) best = { j, h }; }
        T.forEach((t, k) => { if (best && best.j >= t) { hit[k].n++; if (best.h.prog === prog && prog) { hit[k].ok++; hit[k].cost += e.cost; const key = prog; const x = hit[k].ex.get(key) ?? { n: 0, asks: new Set(), cost: 0 }; x.n++; x.cost += e.cost; x.asks.add(e.ask.slice(0, 50)); hit[k].ex.set(key, x); } } }); }
      if (w.size) hist.push({ w, prog }); } }); }
console.log(`held-out episodes with an ask ${total}, spend $${totalCost.toFixed(0)}`);
T.forEach((t, k) => { const h = hit[k]; console.log(`  ask-similarity ≥ ${t}: matched ${(100 * h.n / total).toFixed(1)}%, program predicted exactly ${(100 * h.ok / Math.max(1, h.n)).toFixed(1)}% of matched → ${(100 * h.ok / total).toFixed(1)}% of all episodes, ${(100 * h.cost / totalCost).toFixed(1)}% of spend`);
  for (const [prog, x] of [...h.ex.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6)) console.log(`      ${x.n}× $${x.cost.toFixed(1)}  [${prog.slice(0, 70)}]  e.g. ${[...x.asks].slice(0, 2).join(' | ')}`); });
