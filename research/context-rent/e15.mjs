// E15 — are the PROCEDURAL requests deterministic?
// (a) verify: how concentrated are verify commands per project (top-3 template share)?
//     and given "edits happened since the last verify", how often is the next non-edit action a verify? (train/test by time)
// (b) poll: streak lengths — how many requests does one wait take?
import fs from 'node:fs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const VERIFY = /\b(tsc|jest|vitest|pytest|eslint|lint|test|build|typecheck|mypy|ruff)\b/;
const POLL = /\bsleep\s+\d|\buntil\b.*\bdo\b|\bwhile\b.*\bdo\b|\bgh run (watch|view|list)\b|--follow\b/;
const tpl = (c) => c.replace(/^(cd\s+\S+\s*(&&|;)\s*)+/, '').replace(/(["'])(?:\\.|(?!\1).){0,60}?\1/g, 'S').replace(/\d+/g, '#').replace(/\s*(2>&1|\|\s*(head|tail)[^|;&]*)/g, '').trim().slice(0, 80);
const isEdit = (t) => ['Edit', 'Write', 'MultiEdit'].includes(t.name) || /\bsed\s+-i\b|python3? - <</.test(t.full || '');
const byP = {};
for (const s of ds) (byP[s.project] ??= []).push(s);
const rows = [];
for (const [p, S] of Object.entries(byP)) { if (S.length < 4) continue;
  const counts = new Map(); let verifies = 0;
  for (const s of S) for (const r of s.reqs) for (const t of r.tools) if (t.name === 'Bash' && VERIFY.test(t.full || '') && !POLL.test(t.full || '')) { verifies++; const k = tpl(t.full); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top3 = top.slice(0, 3).reduce((a, x) => a + x[1], 0);
  // (a2) after an edit burst ends (first non-edit request after ≥1 edit request), is it a verify?
  let ends = 0, verifyNext = 0, verifyWithin3 = 0;
  for (const s of S) { let edited = false; s.reqs.forEach((r, k) => {
    const e = r.tools.some(isEdit); const v = r.tools.some((t) => t.name === 'Bash' && VERIFY.test(t.full || ''));
    if (e) { edited = true; return; }
    if (edited && r.tools.length) { ends++; if (v) verifyNext++; if ([0, 1, 2].some((d) => s.reqs[k + d]?.tools.some((t) => t.name === 'Bash' && VERIFY.test(t.full || '')))) verifyWithin3++; edited = false; } }); }
  // (b) poll streaks
  const streaks = []; for (const s of S) { let run = 0; for (const r of s.reqs) { const pol = r.tools.some((t) => t.name === 'Bash' && POLL.test(t.full || '')); if (pol) run++; else if (run) { streaks.push(run); run = 0; } } if (run) streaks.push(run); }
  streaks.sort((a, b) => a - b);
  rows.push({ project: p.slice(0, 26), verifies, templates: counts.size, top3share: +(top3 / Math.max(1, verifies)).toFixed(2), topCmd: top[0]?.[0].slice(0, 46), editBurstEnds: ends, 'P(verify next)': +(verifyNext / Math.max(1, ends)).toFixed(2), 'P(verify ≤3)': +(verifyWithin3 / Math.max(1, ends)).toFixed(2), pollStreaks: streaks.length, 'poll p50/p90': `${streaks[streaks.length >> 1] ?? 0}/${streaks[Math.floor(streaks.length * .9)] ?? 0}` }); }
console.table(rows);
