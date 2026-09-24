// E14 — the cost cube: WHY did each LLM request happen (reason), at what context, and what did it cost?
import fs from 'node:fs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const RO = /^(read|grep|glob|ls|cat|sed|head|tail|find|rg|wc|awk|jq|sort|uniq|cut|tr|diff|stat|tree|toolsearch|git:(log|show|diff|status|branch|blame|ls-files|rev-parse|remote))$/;
const VERIFY = /\b(tsc|jest|vitest|pytest|eslint|lint|test|build|typecheck|mypy|ruff|go test|cargo (test|check|build))\b/;
const DELIVER = /\bgit (commit|push)\b|\bgh pr (create|merge)\b|\b(firebase deploy|vercel|eas (update|build|submit)|gcloud run deploy|npm publish|docker push|kubectl apply|terraform apply)\b/;
const POLL = /\bsleep\s+\d|\buntil\b.*\bdo\b|\bwhile\b.*\bdo\b|\bgh run (watch|view|list)\b|--follow\b|\bwatch\b/;
function reason(r, prev, prevSame) {
  if (!r.tools.length) return 'respond';
  if (prev?.tools.some((t) => t.err)) return 'recover';
  const cmds = r.tools.map((t) => (t.name === 'Bash' ? t.full || '' : ''));
  if (r.tools.some((t) => t.name === 'Agent' || t.name === 'Task')) return 'delegate';
  if (cmds.some((c) => POLL.test(c)) || prevSame) return 'poll/repeat';
  if (cmds.some((c) => DELIVER.test(c))) return 'deliver';
  if (cmds.some((c) => VERIFY.test(c))) return 'verify';
  if (r.tools.every((t) => t.action.split('+').every((v) => RO.test(v)) && !/sed\s+-i|>/.test(t.full || ''))) return 'explore';
  return 'act';
}
const band = (c) => (c < 100e3 ? '<100k' : c < 200e3 ? '100-200k' : c < 400e3 ? '200-400k' : '400k+');
const cube = {}, byReason = {}; let total = 0;
const sig = (r) => r.tools.map((t) => (t.full || t.input || '').replace(/\d+/g, '#')).join('|');
for (const s of ds) s.reqs.forEach((r, k) => { const prev = s.reqs[k - 1]; const same = prev && r.tools.length && sig(r) === sig(prev);
  const why = reason(r, prev, same); const b = band(r.ctx); (cube[why] ??= {})[b] = (cube[why][b] ?? 0) + r.cost; const x = byReason[why] ??= { n: 0, cost: 0, ctx: 0 }; x.n++; x.cost += r.cost; x.ctx += r.ctx; total += r.cost; });
console.log(`total $${total.toFixed(0)}`);
const rows = Object.entries(byReason).sort((a, b) => b[1].cost - a[1].cost).map(([k, x]) => ({ reason: k, requests: x.n, cost: +x.cost.toFixed(0), share: (100 * x.cost / total).toFixed(1) + '%', avgCtxK: Math.round(x.ctx / x.n / 1000), '$/req': +(x.cost / x.n).toFixed(3), ...Object.fromEntries(['<100k', '100-200k', '200-400k', '400k+'].map((b) => [b, +(cube[k][b] ?? 0).toFixed(0)])) }));
console.table(rows);
