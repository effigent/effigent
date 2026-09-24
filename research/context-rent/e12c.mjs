// E12c — lazy CLAUDE.md. Counterfactual: root file = one index line per bullet (its bold title) + the
// non-bullet text; a bullet's BODY enters context only when the session first touches one of the
// bullet's unique identifiers (paths, function/env/collection names) — charged from that request on.
// Liveness proxy is behavioural (what the agent DID), so it misses bullets used purely as guidance;
// the sensitivity row assumes 3× more bullets are needed than the proxy sees.
import fs from 'node:fs'; import { readPrice } from './lib.mjs';
const ds = JSON.parse(fs.readFileSync(process.argv[2])); const file = process.argv[3], project = process.argv[4];
const md = fs.readFileSync(file, 'utf8');
const items = []; let cur = null;
for (const l of md.split('\n')) { if (/^- /.test(l)) { cur && items.push(cur); cur = { text: l }; } else if (cur && (/^\s+\S/.test(l) || l === '')) cur.text += '\n' + l; else { cur && items.push(cur); cur = null; } }
cur && items.push(cur);
const ID = /`([^`\n]{4,80})`|\b([A-Za-z_]+[A-Z_][A-Za-z0-9_]{3,}|[\w-]+\.[a-z]{2,4}|[\w-]+\/[\w./-]+)\b/g;
const idsOf = (t) => { const s = new Set(); for (const m of t.matchAll(ID)) { const v = (m[1] ?? m[2] ?? '').toLowerCase().trim(); if (v.length >= 5 && /[._/]|[a-z][A-Z]/.test(m[1] ?? m[2] ?? '') || /^[A-Z_]{5,}$/.test(m[2] ?? '')) s.add(v.replace(/^\.\//, '')); } return s; };
const df = new Map(); for (const b of items) { b.ids = idsOf(b.text); for (const v of b.ids) df.set(v, (df.get(v) ?? 0) + 1); }
for (const b of items) { b.uniq = [...b.ids].filter((v) => df.get(v) <= 2); b.tok = b.text.length / 3.6; b.titleTok = (b.text.match(/^- \*\*(.+?)\*\*/)?.[0] ?? b.text.slice(0, 120)).length / 3.6; }
const bulletTok = items.reduce((a, b) => a + b.tok, 0), otherTok = md.length / 3.6 - bulletTok, indexTok = items.reduce((a, b) => a + b.titleTok + 8, 0);
console.log(`${items.length} bullets (${(bulletTok / 1e3).toFixed(1)}k tok); lazy root = ${(otherTok / 1e3).toFixed(1)}k other + ${(indexTok / 1e3).toFixed(1)}k index = ${((otherTok + indexTok) / 1e3).toFixed(1)}k tok (was ${(md.length / 3.6 / 1e3).toFixed(1)}k); bullets with ≥1 unique id: ${items.filter((b) => b.uniq.length).length}`);
const S = ds.filter((s) => s.project === project); let obs = 0, cf1 = 0, cf3 = 0; const useCount = new Array(items.length).fill(0); let touchedPerSess = [];
for (const s of S) { const R = s.reqs; const suffix = new Array(R.length + 1).fill(0); for (let k = R.length - 1; k >= 0; k--) suffix[k] = suffix[k + 1] + readPrice(R[k].model);
  obs += (md.length / 3.6) * suffix[0]; cf1 += (otherTok + indexTok) * suffix[0]; cf3 += (otherTok + indexTok) * suffix[0];
  const first = new Map(); for (let k = 0; k < R.length; k++) { const blob = R[k].tools.map((t) => ((t.fp ?? '') + ' ' + (t.full || t.input || '')).toLowerCase()).join(' '); if (!blob) continue;
    items.forEach((b, i) => { if (first.has(i)) return; if (b.uniq.some((v) => blob.includes(v))) first.set(i, k); }); }
  touchedPerSess.push(first.size);
  for (const [i, k] of first) { useCount[i]++; const c = items[i].tok * suffix[k + 1] + items[i].tok * 2 * 5 / 1e6; cf1 += c; cf3 += 3 * c; } }
const med = [...touchedPerSess].sort((a, b) => a - b)[touchedPerSess.length >> 1];
console.log(`sessions ${S.length}: bullets touched per session median ${med}; bullets never touched in any session: ${useCount.filter((x) => x === 0).length}/${items.length}`);
console.log(`CLAUDE.md rent: observed $${obs.toFixed(0)} → lazy $${cf1.toFixed(0)} (saves $${(obs - cf1).toFixed(0)}, ${(100 * (obs - cf1) / obs).toFixed(0)}%) · if 3× more bullets are needed than observed: $${cf3.toFixed(0)} (saves $${(obs - cf3).toFixed(0)}, ${(100 * (obs - cf3) / obs).toFixed(0)}%)`);
const top = items.map((b, i) => ({ uses: useCount[i], ktok: +(b.tok / 1e3).toFixed(1), title: (b.text.match(/^- \*\*(.+?)\*\*/)?.[1] ?? b.text.slice(2, 70)).slice(0, 70) })).sort((a, b) => b.ktok - a.ktok);
console.table(top.slice(0, 10));
