import fs from 'node:fs'; import { episodes, isExplore } from './lib.mjs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const SHIP = /^\s*(please\s+)?(commit|push|deploy)\b[\w\s,&]*$/i;
const rows = []; for (const s of ds) for (const e of episodes(s)) if (SHIP.test(e.ask.trim()) && e.ask.length < 60) {
  const acts = e.tools.map((t) => t.action);
  rows.push({ project: s.project, ask: e.ask.trim().slice(0, 40), reqs: e.reqs.length, calls: acts.length, cost: e.cost, out: e.reqs.reduce((a, r) => a + r.out, 0), ctx: Math.round(e.reqs[0].ctx / 1000), progs: [...new Set(acts.map((a) => a.split('+').map((x) => x.split(':').slice(0, 2).join(':')).join('+')))].slice(0, 6).join(', ') }); }
console.log('ship episodes', rows.length, 'total $', rows.reduce((a, r) => a + r.cost, 0).toFixed(0), 'mean $', (rows.reduce((a, r) => a + r.cost, 0) / rows.length).toFixed(2), 'mean requests', (rows.reduce((a, r) => a + r.reqs, 0) / rows.length).toFixed(1), 'mean ctx at start (k)', (rows.reduce((a, r) => a + r.ctx, 0) / rows.length).toFixed(0));
console.table(rows.slice(-14).map((r) => ({ ...r, cost: +r.cost.toFixed(2) })));
