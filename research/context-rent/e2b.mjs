// E2b — exact rent attribution. Δ_k = out_k (exact: k's generated tokens stay in context) + rest_k
// (tool results of k's calls + next user turn + harness injections), rest split by measured chars.
import fs from 'node:fs'; import { pricingFor } from '../../packages/core/dist/index.js';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const rent = {}; const add = (k, v) => (rent[k] = (rent[k] || 0) + v); let base = 0, obs = 0, writes = 0;
const baseSizes = []; let thinkPersist = { yes: 0, no: 0 };
const perTool = {}; const perAction = {};
for (const s of ds) { const R = s.reqs; if (!R.length) continue; const ctx = R.map((r) => r.ctx);
  const readP = R.map((r) => { const p = pricingFor(r.model); return (p.inputPerM * (p.cacheReadMult ?? 0.1)) / 1e6; });
  for (const r of R) { const p = pricingFor(r.model); obs += (r.cr * p.inputPerM * (p.cacheReadMult ?? 0.1)) / 1e6; }
  const segEnd = new Array(R.length); let end = R.length - 1;
  for (let k = R.length - 1; k >= 0; k--) { segEnd[k] = end; if (k > 0 && ctx[k] < 0.6 * ctx[k - 1]) end = k - 1; }
  const suf = new Array(R.length + 1).fill(0); for (let k = R.length - 1; k >= 0; k--) suf[k] = suf[k + 1] + readP[k];
  const carry = (a, b) => (a > b ? 0 : suf[a] - suf[b + 1]);
  baseSizes.push(ctx[0]); base += ctx[0] * carry(1, segEnd[0]);
  for (let k = 1; k < R.length; k++) if (segEnd[k - 1] === k - 1) base += ctx[k] * carry(k + 1, segEnd[k]);
  for (let k = 0; k + 1 < R.length; k++) { if (segEnd[k] === k) continue; const d = ctx[k + 1] - ctx[k]; if (d <= 0) continue;
    const c = carry(k + 2, segEnd[k + 1]); const r = R[k];
    const think = Math.min(r.think, d), vis = Math.min(r.out - r.think, Math.max(0, d - think));
    // does thinking persist? if Δ < out, some generated tokens did not enter context
    if (r.think > 500) (d >= r.out ? thinkPersist.yes++ : thinkPersist.no++);
    add('assistant: thinking', think * c); add('assistant: text+tool args', vis * c);
    let rest = Math.max(0, d - think - vis);
    const ask = s.asks.find((a) => a.reqIdx === k + 1); const parts = r.tools.map((t) => ({ k: 'tool result: ' + t.name, a: t.action, n: t.resLen ?? 0 }));
    if (ask) parts.push({ k: 'user ask/paste', n: ask.text.length });
    const tot = parts.reduce((a, p) => a + p.n, 0);
    const explained = Math.min(rest, tot / 3.2); // chars→tokens ~3.2 for code/logs
    for (const p of parts) { const v = tot ? (explained * p.n) / tot : 0; add(p.k, v * c); if (p.a) { perAction[p.a] = (perAction[p.a] || 0) + v * c; } }
    add('harness injections (reminders, attachments)', (rest - explained) * c);
  } }
const T = base + Object.values(rent).reduce((a, b) => a + b, 0);
console.log('reads observed $' + obs.toFixed(0), 'modelled $' + T.toFixed(0));
console.log('  base context (system+tools+memory, re-read every request)'.padEnd(62), ('$' + base.toFixed(0)).padStart(6), (100 * base / T).toFixed(1) + '%');
for (const [k, v] of Object.entries(rent).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log('  ' + k.padEnd(60), ('$' + v.toFixed(0)).padStart(6), (100 * v / T).toFixed(1) + '%');
baseSizes.sort((a, b) => a - b); console.log('\nbase context tokens p10', baseSizes[Math.floor(baseSizes.length * .1)], 'p50', baseSizes[baseSizes.length >> 1], 'p90', baseSizes[Math.floor(baseSizes.length * .9)]);
console.log('thinking persists in context (Δ ≥ out when think>500):', thinkPersist);
console.log('\ntop tool-result actions by rent:'); for (const [k, v] of Object.entries(perAction).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log('  ', k.padEnd(40), '$' + v.toFixed(0));
