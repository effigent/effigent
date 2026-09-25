// E26 — validating the savings test itself on real sessions.
//  (1) placebo: cut dates where nothing was applied → how often does it claim a saving (false positives)?
//  (2) known change: agent A's CLAUDE.md grew → the base-tokens metric must come out "worse" at that point
//  (3) power: real after-sessions with context scaled by 0.8 → does it recover ≈ −20%?
import fs from 'node:fs'; import path from 'node:path';
import { parseTranscript, measureEffect } from '../../packages/core/dist/index.js';
const root = process.env.HOME + '/.claude/projects'; const byAgent = {};
for (const d of fs.readdirSync(root)) { const dir = path.join(root, d); if (!fs.statSync(dir).isDirectory()) continue;
  const agent = d.replace(/^-(Users|home)-[^-]+-?/, '').replace(/^(Documents-private-|Documents-|Projects-)/, '') || 'home';
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) { const r = parseTranscript(fs.readFileSync(path.join(dir, f), 'utf8'), { agentId: agent }); if (r) (byAgent[agent] ??= []).push(r); } }
const pct = (v) => `${v >= 0 ? '+' : ''}${(100 * v).toFixed(1)}%`;
// (1) placebo
let tests = 0, claims = { confirmed: 0, regressed: 0, inconclusive: 0 };
for (const [a, runs] of Object.entries(byAgent)) { if (runs.length < 10) continue;
  const s = runs.filter((r) => r.startedAt).sort((x, y) => x.startedAt.localeCompare(y.startedAt));
  for (let i = 4; i < s.length - 4; i += Math.max(1, Math.floor(s.length / 12))) {
    const win = s.slice(Math.max(0, i - 12), i + 12); const e = measureEffect(win, s[i].startedAt, 'generic'); if (e.verdict === 'collecting') continue;
    tests++; claims[e.verdict]++; } }
console.log(`(1) placebo — ${tests} tests at dates where nothing was applied: said "saved" ${claims.confirmed} (${(100 * claims.confirmed / tests).toFixed(0)}%), "worse" ${claims.regressed} (${(100 * claims.regressed / tests).toFixed(0)}%), "inconclusive" ${claims.inconclusive}`);
// (2) known change: the CLAUDE.md growth
const bySize = Object.keys(byAgent).sort((a, b) => byAgent[b].length - byAgent[a].length);
// the agent whose CLAUDE.md grew the most across its sessions
const growth = (a) => { const xs = byAgent[a].filter((r) => r.instructions?.length && r.startedAt).sort((x, y) => x.startedAt.localeCompare(y.startedAt)); if (xs.length < 2) return 0; const c = (r) => r.instructions.reduce((s, f) => s + f.chars, 0); return c(xs[xs.length - 1]) / Math.max(1, c(xs[0])); };
const grown = [...bySize].sort((a, b) => growth(b) - growth(a))[0];
const A = byAgent[grown].filter((r) => r.startedAt).sort((x, y) => x.startedAt.localeCompare(y.startedAt));
for (const cut of ['2026-08-28', '2026-09-04', '2026-09-10']) { const win = A.filter((r) => Math.abs(Date.parse(r.startedAt) - Date.parse(cut)) < 7 * 864e5); const e = measureEffect(win, cut, 'shrink-instructions');
  console.log(`(2) agent A, CLAUDE.md growing, cut ${cut}: ${e.primary?.name} ${Math.round(e.primary?.before / 1000)}k → ${Math.round(e.primary?.after / 1000)}k (${pct(e.primary?.changePct)}, 95% CI ${pct(e.primary?.ci[0])}…${pct(e.primary?.ci[1])}) → ${e.verdict} · n=${e.before.sessions}/${e.after.sessions}`); }
// (3) power: inject a known 20% cut in context (and the cost that goes with it) into real after-sessions
const scale = (run, f) => ({ ...run, costUsd: run.costUsd * f, steps: run.steps.map((s) => s.tokens ? { ...s, tokens: { ...s.tokens, context: Math.round((s.tokens.context ?? 0) * f), cacheRead: Math.round((s.tokens.cacheRead ?? 0) * f), cacheCreation: Math.round((s.tokens.cacheCreation ?? 0) * f), cacheCreation1h: Math.round((s.tokens.cacheCreation1h ?? 0) * f) } } : s) });
for (const a of bySize.slice(0, 4)) { const s = byAgent[a].filter((r) => r.startedAt).sort((x, y) => x.startedAt.localeCompare(y.startedAt)); const mid = Math.floor(s.length / 2);
  const cut = s[mid].startedAt; const win = s.slice(Math.max(0, mid - 15), mid + 15).map((r, i, arr) => (Date.parse(r.startedAt) >= Date.parse(cut) ? scale(r, 0.8) : r));
  const e = measureEffect(win, cut, 'generic');
  console.log(`(3) ${a.padEnd(21)} injected −20%: tokens/request ${pct(e.tokensPerRequest?.changePct ?? NaN)} (CI ${pct(e.tokensPerRequest?.ci[0] ?? NaN)}…${pct(e.tokensPerRequest?.ci[1] ?? NaN)}) → ${e.verdict}${e.sessionsNeeded ? ` · needs ≈${e.sessionsNeeded} sessions per side` : ''} · n=${e.before.sessions}/${e.after.sessions}`); }
// (4) mechanism: simulate adopting "compact at 200k" — replay after-sessions with compaction (context capped) and test the mechanism
const cap = (run, T) => ({ ...run, steps: (() => { let off = 0; return run.steps.map((s) => { if (!s.tokens) return s; let c = s.tokens.context ?? 0; if (c - off > T) off = c - 60000; const nc = Math.max(20000, c - off); const f = nc / Math.max(1, c); return { ...s, tokens: { ...s.tokens, context: nc, cacheRead: Math.round((s.tokens.cacheRead ?? 0) * f) } }; }); })() });
for (const a of bySize.slice(0, 4).filter((x) => byAgent[x].some((r) => r.steps.some((st) => (st.tokens?.context ?? 0) > 250000))).slice(0, 2)) { const s = byAgent[a].filter((r) => r.startedAt).sort((x, y) => x.startedAt.localeCompare(y.startedAt)); const mid = Math.floor(s.length / 2); const cut = s[mid].startedAt;
  const win = s.map((r) => (Date.parse(r.startedAt) >= Date.parse(cut) ? cap(r, 200000) : r)); const e = measureEffect(win, cut, 'compact-earlier', { threshold: 200000 });
  console.log(`(4) ${a.padEnd(21)} compaction at 200k adopted: ${e.primary?.name} ${pct(e.primary?.before ?? NaN).replace('+', '')} → ${pct(e.primary?.after ?? NaN).replace('+', '')} · in effect: ${e.inEffect} · tokens/request ${pct(e.tokensPerRequest?.changePct ?? NaN)} (CI ${pct(e.tokensPerRequest?.ci[0] ?? NaN)}…${pct(e.tokensPerRequest?.ci[1] ?? NaN)}) → ${e.verdict}${e.sessionsNeeded ? ` · money needs ≈${e.sessionsNeeded} sessions/side` : ''} · n=${e.before.sessions}/${e.after.sessions}`); }
