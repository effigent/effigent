// E9 — does the model RE-WRITE the same code? Near-duplicate mining over generated programs
// (Bash commands incl. heredoc scripts, Write bodies). Normalize literals → slots, shingle, MinHash-LSH,
// Jaccard ≥ J → same program. Held-out: cluster on the past, ask what share of FUTURE generated code
// (by chars → output tokens) was a re-write of a past program.
import fs from 'node:fs';
const ds = JSON.parse(fs.readFileSync(process.argv[2])); const J = Number(process.argv[3] ?? 0.7);
const norm = (s) => s
  .replace(/(["'`])(?:\\.|(?!\1).){0,400}?\1/g, 'S')         // string literals
  .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{7,}\b/gi, 'H')          // hashes / ids
  .replace(/\b\d+(\.\d+)?\b/g, 'N')                            // numbers
  .replace(/(?:\/[\w.@-]+){2,}\/?/g, 'P')                      // paths
  .replace(/\s+/g, ' ').trim();
const tokens = (s) => s.match(/[A-Za-z_][\w.]*|[^\sA-Za-z_\d]/g) ?? [];
const K = 5, NH = 64, BANDS = 16, ROWS = NH / BANDS;
const seeds = Array.from({ length: NH }, (_, i) => (i * 2654435761 + 97) >>> 0);
const h32 = (str, seed) => { let h = seed ^ 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
function sig(sh) { const m = new Array(NH).fill(0xffffffff); for (const x of sh) for (let i = 0; i < NH; i++) { const v = h32(x, seeds[i]); if (v < m[i]) m[i] = v; } return m; }
const items = [];
for (const s of ds) for (let k = 0; k < s.reqs.length; k++) for (const t of s.reqs[k].tools) {
  const body = t.full ?? ''; if (body.length < 120) continue;          // short commands are not "programs"
  const n = norm(body); const tk = tokens(n); if (tk.length < 25) continue;
  const sh = new Set(); for (let i = 0; i + K <= tk.length; i++) sh.add(tk.slice(i, i + K).join(' '));
  items.push({ project: s.project, sid: s.sid, start: s.start, tool: t.name, chars: body.length, sh, sig: sig(sh), err: t.err, preview: body.slice(0, 90).replace(/\s+/g, ' '), head: n.slice(0, 60) });
}
const jac = (a, b) => { let i = 0; const [x, y] = a.size < b.size ? [a, b] : [b, a]; for (const v of x) if (y.has(v)) i++; return i / (a.size + b.size - i); };
console.log(`programs (≥120 chars) ${items.length}, total ${(items.reduce((a, x) => a + x.chars, 0) / 1e6).toFixed(1)}M chars`);
// ---- held-out: per project, time-ordered; an item "was a rewrite" if a strictly-earlier-session item matches ----
const byP = {}; for (const it of items) (byP[it.project] ??= []).push(it);
let testChars = 0, hitChars = 0, testN = 0, hitN = 0; const clusters = new Map();
for (const [p, arr] of Object.entries(byP)) {
  const sess = [...new Set(arr.map((x) => x.sid))]; const order = new Map(ds.filter((s) => s.project === p).map((s, i) => [s.sid, i]));
  const cut = Math.floor([...order.keys()].length * 0.7);
  const buckets = new Map(); const seen = [];
  arr.sort((a, b) => order.get(a.sid) - order.get(b.sid));
  for (const it of arr) {
    const isTest = order.get(it.sid) >= cut;
    // candidates via LSH
    const cands = new Set(); for (let b = 0; b < BANDS; b++) { const key = b + ':' + it.sig.slice(b * ROWS, b * ROWS + ROWS).join(','); for (const j of buckets.get(key) ?? []) cands.add(j); }
    let best = null; for (const j of cands) { const o = seen[j]; if (o.sid === it.sid) continue; const v = jac(it.sh, o.sh); if (v >= J && (!best || v > best.v)) best = { v, o }; }
    if (isTest) { testN++; testChars += it.chars; if (best) { hitN++; hitChars += it.chars; } }
    if (best) { const root = best.o.root ?? best.o; it.root = root; const c = clusters.get(root) ?? clusters.set(root, { root, members: [root], sessions: new Set([root.sid]) }).get(root); c.members.push(it); c.sessions.add(it.sid); }
    const idx = seen.push(it) - 1; for (let b = 0; b < BANDS; b++) { const key = b + ':' + it.sig.slice(b * ROWS, b * ROWS + ROWS).join(','); (buckets.get(key) ?? buckets.set(key, []).get(key)).push(idx); }
  } }
console.log(`HELD-OUT (J≥${J}): ${hitN}/${testN} future programs (${(100 * hitN / testN).toFixed(1)}%) = ${(100 * hitChars / testChars).toFixed(1)}% of future generated-code chars were re-writes of a program from an EARLIER session`);
const cl = [...clusters.values()].filter((c) => c.sessions.size >= 3).map((c) => ({ project: c.root.project.slice(0, 18), sessions: c.sessions.size, writes: c.members.length, kchars: +(c.members.reduce((a, x) => a + x.chars, 0) / 1e3).toFixed(1), errRate: +(c.members.filter((x) => x.err).length / c.members.length).toFixed(2), tool: c.root.tool, example: c.root.preview.slice(0, 80) }));
cl.sort((a, b) => b.kchars - a.kchars);
console.log(`clusters spanning ≥3 sessions: ${cl.length}, covering ${cl.reduce((a, c) => a + c.writes, 0)} writes`); console.table(cl.slice(0, 25));
