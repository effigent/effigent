// E13b — measured live-out of exploration bursts: of the lines a burst's results brought in, what share is
// referenced by the main thread AFTER the burst ends (later tool inputs)? That is the summary a subagent
// would have to return — the empirical ρ.
import fs from 'node:fs'; import { isExplore } from './lib.mjs';
const ds = JSON.parse(fs.readFileSync(process.argv[2])); const B = 3; const ratios = []; let wLive = 0, wAll = 0;
const toks = (s) => new Set((s.match(/[A-Za-z0-9_][\w.:/-]{5,}/g) ?? []).map((x) => x.toLowerCase()));
for (const s of ds) { const R = s.reqs; let k = 0;
  while (k < R.length) { let e = k; while (e < R.length && R[e].tools.length && R[e].tools.every((t) => isExplore(t.action))) e++;
    if (e - k >= B && e < R.length) { const later = new Set(); for (let j = e; j < Math.min(R.length, e + 60); j++) for (const t of R[j].tools) for (const x of toks((t.full || t.input) ?? '')) later.add(x);
      // tokens the burst's own inputs used are the QUESTION, not findings — exclude them
      const asked = new Set(); for (let j = k; j < e; j++) for (const t of R[j].tools) for (const x of toks((t.full || t.input) ?? '')) asked.add(x);
      let live = 0, all = 0; for (let j = k; j < e; j++) for (const t of R[j].tools) for (const line of (t.res ?? '').split('\n')) { const lt = [...toks(line)]; if (!lt.length) continue; all += line.length; if (lt.some((x) => later.has(x) && !asked.has(x))) live += line.length; }
      if (all > 500) { ratios.push(live / all); wLive += live; wAll += all; } }
    k = Math.max(e, k + 1); } }
ratios.sort((a, b) => a - b); const q = (p) => ratios[Math.floor(ratios.length * p)].toFixed(2);
console.log(`bursts measured ${ratios.length}: live-out share p25 ${q(.25)} p50 ${q(.5)} p75 ${q(.75)} p90 ${q(.9)} · char-weighted ${(wLive / wAll).toFixed(2)}`);
