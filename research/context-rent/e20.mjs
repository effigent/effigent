// E20 — re-reading a file that has not changed since it was last read (same segment, no edit in between).
// Its result is fully determined → a memo hook could answer "unchanged since request k". Price the duplicate
// deposit's rent (it re-enters context and is carried to the end of the segment).
import fs from 'node:fs'; import { readPrice } from './lib.mjs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const readTarget = (t) => { // → {file, range} for reads
  if (t.name === 'Read' && t.fp) { let o = {}; try { o = JSON.parse(t.input); } catch {} return { file: t.fp, range: `${o.offset ?? 0}:${o.limit ?? 'all'}` }; }
  if (t.name !== 'Bash') return null; const c = (t.full || '').replace(/^(cd\s+\S+\s*(&&|;)\s*)+/, '');
  let m = c.match(/^sed -n\s+['"]?(\d+),(\d+)p['"]?\s+(\S+)\s*$/); if (m) return { file: m[3], range: `${m[1]}:${m[2]}` };
  m = c.match(/^cat\s+(\S+)\s*$/); if (m) return { file: m[1], range: 'all' };
  return null; };
const writes = (t) => { if (['Edit', 'Write', 'MultiEdit'].includes(t.name) && t.fp) return [t.fp]; const c = t.full || ''; if (/sed\s+-i|>\s*\S|python3? - <<|git (checkout|reset|pull|merge|rebase|stash)/.test(c)) return ['*']; return []; };
let reads = 0, dup = 0, dupTok = 0, dupRent = 0, overlapDup = 0; const bySess = [];
for (const s of ds) { const R = s.reqs; const suf = new Array(R.length + 1).fill(0); for (let k = R.length - 1; k >= 0; k--) suf[k] = suf[k + 1] + readPrice(R[k].model);
  const nextReset = new Array(R.length).fill(R.length); for (let k = R.length - 2; k >= 0; k--) nextReset[k] = R[k + 1].ctx < 0.6 * R[k].ctx ? k + 1 : nextReset[k + 1];
  const seen = new Map(); let sd = 0;
  R.forEach((r, k) => { for (const t of r.tools) {
    for (const w of writes(t)) { if (w === '*') seen.clear(); else for (const key of [...seen.keys()]) if (key.startsWith(w.split('/').pop() + '|') || key.startsWith(w + '|')) seen.delete(key); }
    const tg = readTarget(t); if (!tg) continue; reads++;
    const base = tg.file.split('/').pop(); const key = `${base}|${tg.range}`;
    const prev = seen.get(key);
    if (prev != null && nextReset[prev] > k) { dup++; sd++; const tok = (t.resLen ?? 0) / 3.2; dupTok += tok; dupRent += tok * (suf[k + 1] - suf[nextReset[k]]); }
    seen.set(key, k); } });
  bySess.push(sd); }
const total = ds.reduce((a, s) => a + s.reqs.reduce((b, r) => b + r.cost, 0), 0);
console.log(`file reads parsed ${reads} · exact re-reads of an unchanged file+range in the same segment: ${dup} (${(100 * dup / reads).toFixed(1)}%) · ${Math.round(dupTok / 1000)}k tokens · rent $${dupRent.toFixed(0)} (${(100 * dupRent / total).toFixed(2)}% of spend) · sessions with ≥1: ${bySess.filter((x) => x > 0).length}/${ds.length}`);
