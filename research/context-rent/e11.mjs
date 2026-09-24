// E11 — dead-output elimination at the tool boundary. For each Bash result: which LINES are ever used
// again (a distinctive token of the line appears in a later tool input or assistant text of the session)?
// Then test FIXED, rule-based reducers (no learning → no overfit): how many tokens they remove, and what
// share of later-used lines they keep (recall). Rent saved priced with each result's carry.
import fs from 'node:fs'; import path from 'node:path'; import { pricingFor } from '../../packages/core/dist/index.js';
const root = process.env.HOME + '/.claude/projects';
const ERR = /error|warn|fail|✗|✖|exception|denied|not found|cannot|unable|fatal|traceback|panic|refused|invalid|missing|exit code|status\s*[45]\d\d/i;
// reducers map line[] → kept INDEX[] (fixed rules)
const reducers = {
  dedupe: (lines, idx = lines.map((_, j) => j)) => { const out = []; const seen = new Map(); for (const j of idx) { const k = lines[j].replace(/\d+/g, '#').trim(); const n = seen.get(k) ?? 0; seen.set(k, n + 1); if (n < 2) out.push(j); } return out; },
  headTailErr: (lines, idx = lines.map((_, j) => j)) => idx.length <= 120 ? idx : [...idx.slice(0, 40), ...idx.slice(40, -60).filter((j) => ERR.test(lines[j])), ...idx.slice(-60)],
  both: (lines) => reducers.headTailErr(lines, reducers.dedupe(lines)),
};
const fam = (cmd) => { const c = cmd.replace(/^cd [^&;]+(&&|;)\s*/, '').trim(); const w = c.split(/\s+/); const p = (w[0] ?? '').split('/').pop(); return ['npm', 'npx', 'pnpm', 'git', 'gcloud', 'firebase', 'gh', 'eas', 'docker', 'python3', 'node', 'curl', 'sed', 'cat', 'grep', 'ls', 'find'].includes(p) ? p + (['npm', 'pnpm', 'git', 'gcloud', 'firebase', 'gh'].includes(p) && w[1] && !w[1].startsWith('-') ? ':' + w[1] : '') : 'other'; };
const agg = {}; const R = { n: 0 };
for (const d of fs.readdirSync(root)) { const dir = path.join(root, d); if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const L = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && !o.isSidechain);
    const events = []; const cmdById = new Map(); const seenReq = new Set(); let reqIdx = -1; let model = 'claude-opus-5';
    for (const o of L) {
      if (o.type === 'assistant' && o.message) { if (o.message.usage && !seenReq.has(o.requestId) && o.message.model !== '<synthetic>') { seenReq.add(o.requestId); reqIdx++; model = o.message.model; }
        for (const b of o.message.content ?? []) { if (b.type === 'tool_use') { const txt = JSON.stringify(b.input ?? {}); events.push({ k: 'use', req: reqIdx, txt }); if (b.name === 'Bash') cmdById.set(b.id, String(b.input?.command ?? '')); } else if (b.type === 'text') events.push({ k: 'use', req: reqIdx, txt: b.text }); } }
      if (o.type === 'user' && Array.isArray(o.message?.content)) for (const b of o.message.content) if (b.type === 'tool_result' && cmdById.has(b.tool_use_id)) { const txt = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('\n'); events.push({ k: 'res', req: reqIdx, txt, cmd: cmdById.get(b.tool_use_id) }); }
    }
    const totalReqs = reqIdx + 1; const rp = pricingFor(model).inputPerM * (pricingFor(model).cacheReadMult ?? 0.1) / 1e6;
    // later-use corpus per position: build token → last-position index lazily (simple: concatenate all later uses)
    const useTok = events.map((e) => e.k === 'use' ? new Set((e.txt.match(/[A-Za-z0-9_][\w.:/-]{5,}/g) ?? []).map((x) => x.toLowerCase())) : null);
    const laterUses = new Array(events.length + 1).fill(null); { let acc = new Set(); for (let i = events.length - 1; i >= 0; i--) { laterUses[i] = acc; if (useTok[i]) { acc = new Set([...acc, ...useTok[i]]); } } }
    events.forEach((e, i) => { if (e.k !== 'res' || e.txt.length < 400) return; const lines = e.txt.split('\n'); const later = laterUses[i];
      const live = lines.map((l) => (l.match(/[A-Za-z0-9_][\w.:/-]{5,}/g) ?? []).some((t) => later.has(t.toLowerCase())));
      const carry = Math.max(0, totalReqs - e.req - 1) * rp; const tok = e.txt.length / 3.2;
      const F = fam(e.cmd); const a = agg[F] ??= { results: 0, tok: 0, rent: 0, liveLines: 0, lines: 0, red: {} }; a.results++; a.tok += tok; a.rent += tok * carry; a.lines += lines.length; a.liveLines += live.filter(Boolean).length;
      for (const [name, fn] of Object.entries(reducers)) { const kept = new Set(fn(lines)); const keptChars = [...kept].reduce((s, j) => s + lines[j].length + 1, 0);
        const liveKept = live.filter((v, j) => v && kept.has(j)).length; const r = a.red[name] ??= { removedTok: 0, rentSaved: 0, liveLost: 0 }; const removed = (e.txt.length - keptChars) / 3.2; r.removedTok += removed; r.rentSaved += removed * carry; r.liveLost += live.filter(Boolean).length - liveKept; }
    }); } }
const rows = Object.entries(agg).map(([f, a]) => ({ family: f, results: a.results, ktok: Math.round(a.tok / 1e3), rent: +a.rent.toFixed(0), liveLineShare: +(a.liveLines / a.lines).toFixed(2), 'both:removed%': +(100 * a.red.both.removedTok / a.tok).toFixed(0), 'both:rentSaved': +a.red.both.rentSaved.toFixed(0), 'both:liveLinesLost%': +(100 * a.red.both.liveLost / Math.max(1, a.liveLines)).toFixed(1) })).sort((x, y) => y.rent - x.rent);
console.table(rows.slice(0, 16));
const tot = (k) => rows.reduce((s, r) => s + r[k], 0); const all = Object.values(agg);
for (const name of Object.keys(reducers)) { const rem = all.reduce((s, a) => s + a.red[name].removedTok, 0), rs = all.reduce((s, a) => s + a.red[name].rentSaved, 0), lost = all.reduce((s, a) => s + a.red[name].liveLost, 0), live = all.reduce((s, a) => s + a.liveLines, 0), t = all.reduce((s, a) => s + a.tok, 0);
  console.log(`${name.padEnd(12)} removes ${(100 * rem / t).toFixed(1)}% of Bash-output tokens, rent saved $${rs.toFixed(0)}, later-used lines lost ${(100 * lost / live).toFixed(2)}%`); }
console.log('total Bash-output rent (results ≥400 chars) $' + tot('rent'));
