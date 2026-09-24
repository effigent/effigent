// E24 — the edit → verify cycle at the level of the verifier (tsc / vitest / pytest / eslint / build), not the exact
// command. A "re-verify" = a verify request with an edit since the previous verify of the same family in the session.
// A PostToolUse hook that runs the family's check after edits would make those decisions (and their requests)
// unnecessary — the model still reads and fixes the errors, so the new tokens stay.
import fs from 'node:fs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const FAM = [['tsc', /\btsc\b/], ['vitest', /\bvitest\b/], ['jest', /\bjest\b/], ['pytest', /\bpytest\b/], ['eslint', /\beslint\b/], ['go', /\bgo (test|vet|build)\b/], ['build', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/], ['test', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/]];
const famOf = (c) => FAM.find(([, re]) => re.test(c))?.[0];
const isEdit = (t) => ['Edit', 'Write', 'MultiEdit'].includes(t.name) || /\bsed\s+-i\b|python3? - <</.test(t.full || '');
const total = ds.reduce((a, s) => a + s.reqs.reduce((b, r) => b + r.cost, 0), 0);
let verifyReq = 0, verifyCost = 0, reverify = 0, reverifyCost = 0, reverifyNewTok = 0, failShare = 0; const byFam = {}; const perProject = {};
for (const s of ds) { const edited = {}; s.reqs.forEach((r, k) => {
  if (r.tools.some(isEdit)) for (const f of FAM.map(([n]) => n)) edited[f] = true;
  const fams = [...new Set(r.tools.map((t) => famOf(t.full || '')).filter(Boolean))]; if (!fams.length) return;
  verifyReq++; verifyCost += r.cost; const re = fams.some((f) => edited[f]);
  if (re) { reverify++; reverifyCost += r.cost; const next = s.reqs[k + 1]; if (next) reverifyNewTok += Math.max(0, next.ctx - r.ctx); if (r.tools.some((t) => t.err)) failShare++;
    for (const f of fams) { const x = byFam[f] ??= { n: 0, cost: 0 }; x.n++; x.cost += r.cost; }
    const p = perProject[s.project] ??= { n: 0, cost: 0, sess: new Set() }; p.n++; p.cost += r.cost; p.sess.add(s.sid); }
  for (const f of fams) edited[f] = false; }); }
console.log(`verify requests ${verifyReq} ($${verifyCost.toFixed(0)}, ${(100 * verifyCost / total).toFixed(1)}% of spend) · re-verifies after an edit ${reverify} ($${reverifyCost.toFixed(0)}, ${(100 * reverifyCost / total).toFixed(1)}%) · ${(100 * failShare / Math.max(1, reverify)).toFixed(0)}% of re-verifies failed`);
console.log('by verifier:', Object.fromEntries(Object.entries(byFam).map(([k, x]) => [k, `${x.n} · $${x.cost.toFixed(0)}`])));
console.log('by project:', Object.fromEntries(Object.entries(perProject).map(([k, x]) => [k.slice(-20), `${x.n} in ${x.sess.size} sessions · $${x.cost.toFixed(0)}`])));
