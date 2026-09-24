// E12b — route each CLAUDE.md bullet to the area (top-level dir) its paths name; a session loads a
// nested CLAUDE.md only for areas it touches (Claude Code loads nested files on demand).
// Counterfactual base per session = unrouted bullets + bullets of touched areas. Priced with rent.
import fs from 'node:fs'; import path from 'node:path'; import { readPrice } from './lib.mjs';
const ds = JSON.parse(fs.readFileSync(process.argv[2])); const file = process.argv[3], project = process.argv[4];
const repo = path.dirname(file); const areas = fs.readdirSync(repo).filter((d) => fs.statSync(path.join(repo, d)).isDirectory() && !d.startsWith('.') && d !== 'node_modules');
const md = fs.readFileSync(file, 'utf8');
// bullets = top-level "- " items with their continuation lines, anywhere in the file
const items = []; let cur = null;
for (const l of md.split('\n')) { if (/^- /.test(l)) { cur && items.push(cur); cur = { text: l }; } else if (cur && (/^\s+\S/.test(l) || l === '')) cur.text += '\n' + l; else { cur && items.push(cur); cur = null; } }
cur && items.push(cur);
const bulletChars = items.reduce((a, b) => a + b.text.length, 0);
const areaOf = (txt) => { const hits = new Map(); for (const a of areas) { const re = new RegExp('(^|[\\s`(/])' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/', 'g'); const n = (txt.match(re) ?? []).length; if (n) hits.set(a, n); }
  // also: well-known path roots used without the area prefix
  return [...hits.entries()].sort((x, y) => y[1] - x[1]).map(([a]) => a); };
for (const b of items) b.areas = areaOf(b.text);
const routed = items.filter((b) => b.areas.length === 1), multi = items.filter((b) => b.areas.length > 1), general = items.filter((b) => !b.areas.length);
const T = (arr) => arr.reduce((a, b) => a + b.text.length, 0) / 3.6;
console.log(`areas: ${areas.join(', ')}`);
console.log(`${items.length} bullets = ${(bulletChars / 3.6 / 1e3).toFixed(1)}k tok of ${(md.length / 3.6 / 1e3).toFixed(1)}k · single-area ${routed.length} (${(T(routed) / 1e3).toFixed(1)}k) · multi-area ${multi.length} (${(T(multi) / 1e3).toFixed(1)}k) · no area ${general.length} (${(T(general) / 1e3).toFixed(1)}k)`);
const perArea = {}; for (const b of routed) perArea[b.areas[0]] = (perArea[b.areas[0]] ?? 0) + b.text.length / 3.6; console.log('single-area tokens by area:', Object.fromEntries(Object.entries(perArea).map(([k, v]) => [k, Math.round(v)])));
// sessions: areas touched (tool paths relative to repo)
const S = ds.filter((s) => s.project === project); let obs = 0, cf = 0; const touchDist = {};
const fixed = md.length / 3.6 - T(routed); // everything not routable stays in the root file
for (const s of S) { const touched = new Set(); for (const r of s.reqs) for (const t of r.tools) { const blob = (t.fp ?? '') + ' ' + (t.full || t.input || ''); for (const a of areas) if (blob.includes(repo + '/' + a + '/') || new RegExp('(^|[\\s"\'`])(\\./)?' + a + '/').test(blob) || blob.includes('cd ' + a)) touched.add(a); }
  touchDist[touched.size] = (touchDist[touched.size] ?? 0) + 1;
  const loaded = fixed + [...touched].reduce((a, x) => a + (perArea[x] ?? 0), 0);
  const reads = s.reqs.reduce((a, r) => a + readPrice(r.model), 0);
  obs += (md.length / 3.6) * reads; cf += loaded * reads; }
console.log('sessions by #areas touched:', touchDist);
console.log(`CLAUDE.md rent: observed $${obs.toFixed(0)} → routed $${cf.toFixed(0)}  saves $${(obs - cf).toFixed(0)} (${(100 * (obs - cf) / obs).toFixed(0)}%) — conservative: a touched area is charged from the first request`);
