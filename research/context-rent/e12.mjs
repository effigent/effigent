// E12 — CLAUDE.md liveness. The project instructions are part of the base context: re-read on EVERY
// request. (a) price them exactly; (b) split into sections and ask, across all sessions, whether the
// agent's behaviour ever touches a section (its distinctive identifiers — paths, commands, env names —
// appear in later tool inputs / assistant text). A never-touched section is a dead declaration: it can
// move to a lazily-loaded place (nested CLAUDE.md in its subdirectory, or a skill whose body loads on use).
import fs from 'node:fs'; import { readPrice } from './lib.mjs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const file = process.argv[3], project = process.argv[4];
const md = fs.readFileSync(file, 'utf8'); const mdTok = md.length / 3.6;
const S = ds.filter((s) => s.project === project);
let reads = 0, reqs = 0; for (const s of S) for (const r of s.reqs) { reads += readPrice(r.model); reqs++; }
console.log(`${file}: ${(md.length / 1e3).toFixed(0)}k chars ≈ ${(mdTok / 1e3).toFixed(0)}k tokens · ${S.length} sessions, ${reqs} requests`);
console.log(`rent of CLAUDE.md alone ≈ $${(mdTok * reads).toFixed(0)} of $${S.reduce((a, s) => a + s.reqs.reduce((b, r) => b + r.cost, 0), 0).toFixed(0)} project spend (upper bound: assumes it is in every request's context)`);
// sections by markdown heading (## / ###)
const lines = md.split('\n'); const secs = []; let cur = { title: '(preamble)', text: [] };
for (const l of lines) { if (/^#{2,3} /.test(l)) { secs.push(cur); cur = { title: l.replace(/^#+ /, ''), text: [] }; } else cur.text.push(l); } secs.push(cur);
// usage corpus: everything the agent DID (tool inputs, full commands) — not what it read
const corpus = new Map(); // token -> sessions set
const add = (t, sid) => { (corpus.get(t) ?? corpus.set(t, new Set()).get(t)).add(sid); };
for (const s of S) for (const r of s.reqs) for (const t of r.tools) for (const w of ((t.full || t.input) ?? '').match(/[A-Za-z_][\w./-]{5,}/g) ?? []) add(w.toLowerCase(), s.sid);
const df = new Map(); for (const sec of secs) for (const w of new Set((sec.text.join('\n').match(/[A-Za-z_][\w./-]{5,}/g) ?? []).map((x) => x.toLowerCase()))) df.set(w, (df.get(w) ?? 0) + 1);
const rows = secs.map((sec) => { const txt = sec.text.join('\n'); const words = [...new Set((txt.match(/[A-Za-z_][\w./-]{5,}/g) ?? []).map((x) => x.toLowerCase()))].filter((w) => df.get(w) <= 3 && /[./_-]|[A-Z]/.test(w) || df.get(w) === 1);
  const sessionsTouched = new Set(); for (const w of words) for (const sid of corpus.get(w) ?? []) sessionsTouched.add(sid);
  return { section: sec.title.slice(0, 50), ktok: +(txt.length / 3.6 / 1e3).toFixed(1), ids: words.length, sessionsUsing: sessionsTouched.size, share: +(sessionsTouched.size / S.length).toFixed(2) }; });
const tot = rows.reduce((a, r) => a + r.ktok, 0);
const bands = [[0, 0], [0.01, 0.1], [0.1, 0.3], [0.3, 1.01]]; for (const [lo, hi] of bands) { const b = rows.filter((r) => (hi === 0 ? r.share === 0 : r.share >= lo && r.share < hi)); console.log(`sections used by ${hi === 0 ? 'NO session' : `${lo * 100}-${Math.min(100, hi * 100)}% of sessions`}: ${b.length} sections, ${b.reduce((a, r) => a + r.ktok, 0).toFixed(1)}k tokens (${(100 * b.reduce((a, r) => a + r.ktok, 0) / tot).toFixed(0)}%)`); }
rows.sort((a, b) => b.ktok - a.ktok); console.table(rows.slice(0, 20));
