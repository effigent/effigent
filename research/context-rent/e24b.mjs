// E24b — did the re-verifies actually FIND problems? Judge by output content (exit codes are masked by `| head`).
import fs from 'node:fs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const FAM = [['tsc', /\btsc\b/, /error TS\d+/], ['vitest', /\bvitest\b/, /\b(\d+ failed|FAIL\b)/], ['pytest', /\bpytest\b/, /\b\d+ (failed|error)/], ['eslint', /\beslint\b/, /\b\d+ (problems?|errors?)\b|✖/], ['test', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/, /\b(failed|FAIL\b|failing)/], ['build', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/, /\b(error|Failed to compile)\b/i]];
const isEdit = (t) => ['Edit', 'Write', 'MultiEdit'].includes(t.name) || /\bsed\s+-i\b|python3? - <</.test(t.full || '');
const st = {}; let silentPass = 0;
for (const s of ds) { let edited = false; for (const r of s.reqs) { if (r.tools.some(isEdit)) edited = true;
  for (const t of r.tools) { const c = t.full || ''; const f = FAM.find(([, re]) => re.test(c)); if (!f || !edited) continue;
    const x = st[f[0]] ??= { n: 0, found: 0, clean: 0, unknown: 0, cleanCost: 0 }; x.n++;
    const out = t.res ?? ''; if (f[2].test(out) || t.err) x.found++; else if (out.trim().length < 400) { x.clean++; x.cleanCost += r.cost; } else x.unknown++; }
  if (r.tools.some((t) => FAM.some(([, re]) => re.test(t.full || '')))) edited = false; } }
console.log(st);
const T = Object.values(st).reduce((a, x) => ({ n: a.n + x.n, found: a.found + x.found, clean: a.clean + x.clean, cost: a.cost + x.cleanCost }), { n: 0, found: 0, clean: 0, cost: 0 });
console.log(`re-verifies ${T.n}: found problems ${T.found} (${(100 * T.found / T.n).toFixed(0)}%) · came back clean ${T.clean} (${(100 * T.clean / T.n).toFixed(0)}%, $${T.cost.toFixed(0)} spent on requests that only confirmed "no errors")`);
