// E19 — how many episodes have an OBSERVABLE outcome in the data we have, and what denials cost.
import fs from 'node:fs'; import { episodes } from './lib.mjs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
let eps = 0, withGit = 0, withPr = 0, withEdit = 0, answered = 0, costAll = 0, costGit = 0; let denies = 0, denyReqCost = 0; const kinds = {};
for (const s of ds) { const E = episodes(s); const ev = s.ev;
  E.forEach((e, i) => { eps++; costAll += e.cost; const t0 = e.reqs[0]?.ts, t1 = E[i + 1]?.reqs[0]?.ts ?? '9999';
    const inEp = (x) => x.ts >= t0 && x.ts < t1;
    const git = ev.filter((x) => x.t === 'git' && inEp(x)); const pr = ev.filter((x) => x.t === 'pr' && inEp(x));
    if (git.length) { withGit++; costGit += e.cost; } if (pr.length) withPr++;
    if (e.tools.some((t) => ['Edit', 'Write', 'MultiEdit'].includes(t.name))) withEdit++; else if (!e.tools.length || e.tools.every((t) => !['Edit', 'Write'].includes(t.name))) answered++; });
  // denials: the request that issued a denied call + the next one (re-plan)
  for (const d of ev.filter((x) => x.t === 'deny')) { denies++; kinds[d.kind] = (kinds[d.kind] ?? 0) + 1; const k = s.reqs.findIndex((r) => r.ts >= d.ts); if (k > 0) denyReqCost += s.reqs[k - 1].cost + (s.reqs[k]?.cost ?? 0); } }
console.log(`episodes ${eps}: with a git op (commit/push/PR) ${withGit} (${(100 * withGit / eps).toFixed(0)}%, ${(100 * costGit / costAll).toFixed(0)}% of episode spend) · PR link ${withPr} · with edits ${withEdit} (${(100 * withEdit / eps).toFixed(0)}%) · no edits (answer/explore) ${answered}`);
console.log(`denied tool calls ${denies} ${JSON.stringify(kinds)} · issuing + re-plan requests cost ≈ $${denyReqCost.toFixed(0)}`);
