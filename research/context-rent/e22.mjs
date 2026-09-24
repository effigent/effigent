// E22 — loops INSIDE runs. Per session, the request sequence as decisions (sorted action tokens). Find tandem
// repeats: a body of p consecutive decisions (p = 1..6) repeated ≥3 times in a row (exact token match). Greedy,
// longest coverage first, non-overlapping. Classify by what the iterations share and what varies:
//   poll       — wait/status commands, same args
//   retry      — same args again right after an error
//   fix-verify — body has an edit AND a verify (tsc/test/build/lint)
//   collection — same body, an argument slot varies (file/id/url), no errors  → batch tool
//   repeat     — same body, same args, no error (redundant)
//   other
// Price: loop spend, and what a tool would leave (one request instead of k).
import fs from 'node:fs'; import { columnTemplate } from '../../packages/core/dist/index.js';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const VERIFY = /\b(tsc|jest|vitest|pytest|eslint|typecheck|mypy|ruff)\b|\b(npm|pnpm|yarn)\s+(run\s+)?(test|build|lint|typecheck)\b/;
const WAIT = /\bsleep\s+\d|\bgh run (watch|view|list)\b|--follow\b|\bstatus\b/;
const EDIT = (t) => ['Edit', 'Write', 'MultiEdit'].includes(t.name) || /\bsed\s+-i\b|python3? - <</.test(t.full || '');
const dec = (r) => (r.tools.length ? r.tools.map((t) => t.action).sort().join('&') : 'respond');
const argOf = (r) => r.tools.map((t) => (t.full || t.fp || t.input || '').replace(/\s+/g, ' ').slice(0, 300)).join(' ¦ ');
const total = ds.reduce((a, s) => a + s.reqs.reduce((b, r) => b + r.cost, 0), 0);
const agg = {}; const loopsAll = [];
for (const s of ds) { const R = s.reqs; const D = R.map(dec); const used = new Array(R.length).fill(false);
  const cands = [];
  for (let p = 1; p <= 6; p++) for (let i = 0; i + 2 * p <= R.length; i++) {
    if (D[i] === 'respond') continue;
    let k = 1; while (i + (k + 1) * p <= R.length && D.slice(i, i + p).every((d, j) => d === D[i + k * p + j])) k++;
    if (k >= 3) cands.push({ i, p, k, cover: p * k });
  }
  cands.sort((a, b) => b.cover - a.cover || a.p - b.p);
  for (const c of cands) { const idx = [...Array(c.cover).keys()].map((j) => c.i + j); if (idx.some((j) => used[j])) continue; idx.forEach((j) => (used[j] = true));
    const its = [...Array(c.k).keys()].map((m) => R.slice(c.i + m * c.p, c.i + (m + 1) * c.p));
    const args = its.map((it) => it.map(argOf).join(' ⏐ '));
    const tools = its.flatMap((it) => it.flatMap((r) => r.tools));
    const errs = tools.filter((t) => t.err).length; const cmds = tools.map((t) => t.full || '');
    const same = new Set(args).size === 1; const tpl = columnTemplate(args);
    let kind = 'other';
    if (cmds.some((c) => WAIT.test(c)) && (same || tpl?.stability > 0.6)) kind = 'poll';
    else if (tools.some(EDIT) && cmds.some((c) => VERIFY.test(c))) kind = 'fix-verify';
    else if (same && errs > 0) kind = 'retry';
    else if (same) kind = 'repeat';
    else if (errs === 0 && tpl && tpl.slots > 0 && tpl.stability >= 0.5) kind = 'collection';
    const cost = its.flat().reduce((a, r) => a + r.cost, 0); const perIter = cost / c.k;
    const toolLeft = kind === 'fix-verify' ? cost * 0.5 : perIter; // collection/poll/retry/repeat: one request instead of k
    const x = agg[kind] ??= { loops: 0, iters: 0, reqs: 0, cost: 0, saved: 0, sess: new Set(), ex: [] };
    x.loops++; x.iters += c.k; x.reqs += c.cover; x.cost += cost; x.saved += cost - toolLeft; x.sess.add(s.sid);
    if (x.ex.length < 4 && cost > 1) x.ex.push(`${c.k}× [${D.slice(c.i, c.i + c.p).join(' → ').slice(0, 60)}] $${cost.toFixed(1)} · ${(tpl?.template ?? args[0]).slice(0, 90)}`);
    loopsAll.push({ kind, k: c.k, p: c.p, cost });
  } }
const inLoops = Object.values(agg).reduce((a, x) => a + x.cost, 0);
console.log(`sessions ${ds.length} · spend in intra-run loops $${inLoops.toFixed(0)} (${(100 * inLoops / total).toFixed(1)}% of $${total.toFixed(0)}) · loops ${loopsAll.length}`);
console.table(Object.fromEntries(Object.entries(agg).sort((a, b) => b[1].cost - a[1].cost).map(([k, x]) => [k, { loops: x.loops, sessions: x.sess.size, 'avg iters': +(x.iters / x.loops).toFixed(1), requests: x.reqs, cost: +x.cost.toFixed(0), 'share %': +(100 * x.cost / total).toFixed(1), 'tool would save': +x.saved.toFixed(0) }])));
for (const [k, x] of Object.entries(agg)) { console.log(`\n${k}:`); for (const e of x.ex) console.log('   ' + e); }
