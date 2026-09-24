// E23 — procedural loops inside runs, detected on the COMMANDS (not on decision tokens).
import fs from 'node:fs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const VERIFY = /\b(tsc|jest|vitest|pytest|eslint|typecheck|mypy|ruff|go (test|vet|build)|cargo (test|check))\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck)\b/;
const WAITY = /\bsleep\s+\d|\bgh run (watch|view|list)\b|\bkubectl (get|rollout status)\b|--follow\b|\bcurl\b[^|]*\b(health|status)\b|\bgcloud (run|builds) .*describe\b/;
const strip = (c) => c.replace(/^(\s*(cd|export)\s+[^&;\n]+(&&|;)\s*)+/, '').trim();
const tpl = (c) => c.replace(/(["'])(?:\\.|(?!\1)[^\\\n]){0,40}\1/g, '⟨s⟩').replace(/\b[0-9a-f]{7,}\b/gi, '⟨h⟩').replace(/\d+/g, '⟨n⟩').replace(/(?:\/[\w.@-]+)+/g, '⟨p⟩').replace(/\s+/g, ' ').slice(0, 160);
const pageOf = (t) => { if (t.name === 'Read' && t.fp) return t.fp; const m = strip(t.full || '').match(/^(?:sed -n\s+['"]?\d+,\d+p['"]?|head -n?\s*\d+|tail -n?\s*\+?\d+)\s+(\S+)/); return m ? m[1] : null; };
const isEdit = (t) => ['Edit', 'Write', 'MultiEdit'].includes(t.name) || /\bsed\s+-i\b|python3? - <</.test(t.full || '');
const total = ds.reduce((a, s) => a + s.reqs.reduce((b, r) => b + r.cost, 0), 0);
const agg = {}; const add = (kind, s, reqIdx, k, ex) => { const cost = [...new Set(reqIdx)].reduce((a, i) => a + s.reqs[i].cost, 0); const per = cost / Math.max(1, new Set(reqIdx).size);
  const saved = kind === 'fix-verify' ? ex.verifyCost * 0.8 : Math.max(0, cost - per) * 0.8; // one request (or a hook) instead of k; 20% kept for the new tokens
  const x = agg[kind] ??= { loops: 0, iters: 0, cost: 0, saved: 0, sess: new Set(), ex: [], tpls: new Map() }; x.loops++; x.iters += k; x.cost += cost; x.saved += saved; x.sess.add(s.project + '/' + s.sid);
  x.tpls.set(ex.tpl, (x.tpls.get(ex.tpl) ?? 0) + 1); if (x.ex.length < 5 && cost > 1) x.ex.push(`${k}× $${cost.toFixed(2)} · ${ex.tpl.slice(0, 110)}`); };
for (const s of ds) {
  const calls = []; s.reqs.forEach((r, i) => r.tools.forEach((t) => calls.push({ i, t, cmd: strip(t.full || ''), tp: t.name === 'Bash' ? tpl(strip(t.full || '')) : t.name + ':' + tpl(t.fp || '') })));
  const used = new Set();
  // paging: ≥3 reads of the same file within a short span
  for (let a = 0; a < calls.length; a++) { const f = pageOf(calls[a].t); if (!f || used.has(a)) continue; const run = [a];
    for (let b = a + 1; b < calls.length && calls[b].i - calls[run[run.length - 1]].i <= 2; b++) if (pageOf(calls[b].t) === f) run.push(b); else if (!calls[b].t.name.match(/Read|Bash/)) break;
    if (run.length >= 3) { run.forEach((x) => used.add(x)); add('paging', s, run.map((x) => calls[x].i), run.length, { tpl: 'read in slices: …/' + f.split('/').slice(-2).join('/') }); } }
  // retry: the identical command re-run right after it failed
  for (let a = 0; a < calls.length; a++) { if (used.has(a) || !calls[a].t.err || !calls[a].cmd) continue; const run = [a];
    for (let b = a + 1; b < calls.length && calls[b].i - calls[run[run.length - 1]].i <= 2; b++) if (calls[b].cmd === calls[a].cmd) { run.push(b); if (!calls[b].t.err) break; }
    if (run.length >= 2) { run.forEach((x) => used.add(x)); add('retry', s, run.map((x) => calls[x].i), run.length, { tpl: calls[a].tp }); } }
  // poll: same template ≥3 times, wait-like
  const byTpl = new Map(); calls.forEach((c, x) => { if (c.t.name === 'Bash' && !used.has(x)) (byTpl.get(c.tp) ?? byTpl.set(c.tp, []).get(c.tp)).push(x); });
  for (const [tp, xs] of byTpl) { if (!WAITY.test(calls[xs[0]].cmd)) continue; let run = [xs[0]];
    const flush = () => { if (run.length >= 3) { run.forEach((x) => used.add(x)); add('poll', s, run.map((x) => calls[x].i), run.length, { tpl: tp }); } };
    for (let j = 1; j < xs.length; j++) { if (calls[xs[j]].i - calls[run[run.length - 1]].i <= 3) run.push(xs[j]); else { flush(); run = [xs[j]]; } } flush(); }
  // fix-verify: same verify template ≥3 times in a run with edits between consecutive runs of it
  for (const [tp, xs] of byTpl) { if (!VERIFY.test(calls[xs[0]].cmd)) continue; let run = [xs[0]];
    const flush = () => { if (run.length >= 3) { const lo = calls[run[0]].i, hi = calls[run[run.length - 1]].i; const idx = []; for (let i = lo; i <= hi; i++) idx.push(i);
        const verifyCost = run.reduce((a, x) => a + s.reqs[calls[x].i].cost, 0); run.forEach((x) => used.add(x)); add('fix-verify', s, idx, run.length, { tpl: tp, verifyCost }); } };
    for (let j = 1; j < xs.length; j++) { const between = calls.filter((c, x) => x > run[run.length - 1] && x < xs[j]); const edited = between.some((c) => isEdit(c.t));
      if (edited && calls[xs[j]].i - calls[run[run.length - 1]].i <= 25) run.push(xs[j]); else { flush(); run = [xs[j]]; } } flush(); }
  // collection: ≥3 consecutive calls sharing a template with DIFFERENT args, no errors, not edits
  for (let a = 0; a < calls.length; a++) { if (used.has(a) || calls[a].t.name !== 'Bash' || isEdit(calls[a].t) || calls[a].t.err) continue; const run = [a];
    for (let b = a + 1; b < calls.length && calls[b].i - calls[run[run.length - 1]].i <= 2; b++) { if (used.has(b)) break; if (calls[b].tp === calls[a].tp && !calls[b].t.err) run.push(b); else if (calls[b].t.name === 'Bash') break; }
    const distinct = new Set(run.map((x) => calls[x].cmd)).size;
    if (run.length >= 3 && distinct >= Math.ceil(run.length * 0.7)) { run.forEach((x) => used.add(x)); add('collection', s, run.map((x) => calls[x].i), run.length, { tpl: calls[a].tp }); } }
}
const inLoops = Object.values(agg).reduce((a, x) => a + x.cost, 0), saved = Object.values(agg).reduce((a, x) => a + x.saved, 0);
console.log(`procedural loops: $${inLoops.toFixed(0)} of spend (${(100 * inLoops / total).toFixed(1)}%) · a tool/hook per loop would save ≈$${saved.toFixed(0)} (${(100 * saved / total).toFixed(1)}%)`);
console.table(Object.fromEntries(Object.entries(agg).sort((a, b) => b[1].cost - a[1].cost).map(([k, x]) => [k, { loops: x.loops, sessions: x.sess.size, 'avg iters': +(x.iters / x.loops).toFixed(1), cost: +x.cost.toFixed(0), 'tool saves': +x.saved.toFixed(0), 'distinct templates': x.tpls.size, 'recurring templates (≥3 loops)': [...x.tpls.values()].filter((n) => n >= 3).length }])));
for (const [k, x] of Object.entries(agg)) { console.log(`\n${k} — top recurring: ${[...x.tpls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${n}× ${t.slice(0, 70)}`).join(' | ')}`); for (const e of x.ex) console.log('   ' + e); }
