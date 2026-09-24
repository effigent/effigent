// E18 — does more STATE make behaviour predictable? Predict the next request's REASON (explore/act/verify/
// deliver/respond/recover/wait/delegate) on held-out sessions (per project, first 70% by time train),
// with nested feature sets. Report accuracy, coverage@0.7, and log-loss vs the base rate.
import fs from 'node:fs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const RO = /^(read|grep|glob|ls|cat|sed|head|tail|find|rg|wc|awk|jq|sort|uniq|cut|tr|diff|stat|tree|toolsearch|git:(log|show|diff|status|branch|blame|ls-files|rev-parse|remote))$/;
const VERIFY = /\b(tsc|jest|vitest|pytest|eslint|typecheck|mypy|ruff)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck)\b/;
const DELIVER = /\bgit (commit|push)\b|\bgh pr (create|merge)\b|\b(firebase deploy|vercel|eas (update|build|submit)|gcloud run deploy)\b/;
const WAIT = /\bsleep\s+\d|\bgh run (watch|view)\b|--follow\b/;
const reason = (r, prev) => { if (!r.tools.length) return 'respond'; if (r.tools.some((t) => t.name === 'Agent' || t.name === 'Task')) return 'delegate'; if (prev?.tools.some((t) => t.err)) return 'recover';
  const c = r.tools.map((t) => t.full || ''); if (c.some((x) => WAIT.test(x))) return 'wait'; if (c.some((x) => DELIVER.test(x))) return 'deliver'; if (c.some((x) => VERIFY.test(x))) return 'verify';
  if (r.tools.every((t) => t.action.split('+').every((v) => RO.test(v)) && !/sed\s+-i|>/.test(t.full || ''))) return 'explore'; return 'act'; };
const ASKV = (t) => (t.toLowerCase().match(/\b(fix|add|implement|deploy|commit|push|test|check|why|what|how|find|review|create|update|remove|refactor|build|run|show|explain)\b/) ?? ['other'])[0];
const FEATS = {
  'last 2 reasons': (x) => x.r1 + '|' + x.r2,
  '+ last call failed': (x) => x.r1 + '|' + x.r2 + '|' + x.err,
  '+ ask verb': (x) => x.r1 + '|' + x.r2 + '|' + x.err + '|' + x.ask,
  '+ position in episode': (x) => x.r1 + '|' + x.r2 + '|' + x.err + '|' + x.ask + '|' + x.pos,
};
const byP = {}; for (const s of ds) (byP[s.project] ??= []).push(s);
const res = {}; let base = { n: 0, ll: 0 };
const rows = (s) => { const out = []; let ask = 'other', since = 0; const askAt = new Map(s.asks.map((a) => [a.reqIdx, a.text]));
  s.reqs.forEach((r, k) => { if (askAt.has(k)) { ask = ASKV(askAt.get(k)); since = 0; } const prev = s.reqs[k - 1], prev2 = s.reqs[k - 2];
    out.push({ y: reason(r, prev), r1: prev ? reason(prev, prev2) : 'START', r2: prev2 ? reason(prev2, s.reqs[k - 3]) : 'START', err: prev?.tools.some((t) => t.err) ? 'E' : 'ok', ask, pos: since < 3 ? since : since < 10 ? 'mid' : 'late' }); since++; });
  return out; };
for (const [p, S] of Object.entries(byP)) { if (S.length < 4) continue; const cut = Math.floor(S.length * 0.7);
  const train = S.slice(0, cut).flatMap(rows), test = S.slice(cut).flatMap(rows);
  const prior = new Map(); for (const x of train) prior.set(x.y, (prior.get(x.y) ?? 0) + 1);
  const K = 8, pr = (y) => ((prior.get(y) ?? 0) + 1) / (train.length + K);
  for (const x of test) { base.n++; base.ll -= Math.log(pr(x.y)); }
  for (const [name, f] of Object.entries(FEATS)) { const tab = new Map(); for (const x of train) { const k = f(x); const m = tab.get(k) ?? tab.set(k, new Map()).get(k); m.set(x.y, (m.get(x.y) ?? 0) + 1); }
    const R = res[name] ??= { n: 0, ok: 0, ll: 0, cov: 0, covOk: 0 };
    for (const x of test) { const m = tab.get(f(x)); const n = m ? [...m.values()].reduce((a, b) => a + b, 0) : 0;
      // backoff-smoothed probability: table estimate shrunk toward the prior
      const p = (y) => ((m?.get(y) ?? 0) + 5 * pr(y)) / (n + 5);
      const top = m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : [...prior.entries()].sort((a, b) => b[1] - a[1])[0][0];
      R.n++; if (top === x.y) R.ok++; R.ll -= Math.log(p(x.y)); if (p(top) >= 0.7) { R.cov++; if (top === x.y) R.covOk++; } } } }
console.log(`held-out requests ${base.n} · base-rate log-loss ${(base.ll / base.n).toFixed(3)} nats`);
for (const [name, R] of Object.entries(res)) console.log(`${name.padEnd(24)} accuracy ${(100 * R.ok / R.n).toFixed(1)}% · log-loss ${(R.ll / R.n).toFixed(3)} (${(100 * (1 - R.ll / base.ll)).toFixed(1)}% of uncertainty explained) · coverage@0.7 ${(100 * R.cov / R.n).toFixed(1)}% at ${(100 * R.covOk / Math.max(1, R.cov)).toFixed(0)}% precision`);
