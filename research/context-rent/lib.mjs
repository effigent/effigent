import { pricingFor } from '../../packages/core/dist/index.js';
export const readPrice = (m) => { const p = pricingFor(m); return (p.inputPerM * (p.cacheReadMult ?? 0.1)) / 1e6; };
const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6}|[\w-]+\.(?:ts|tsx|js|py|json|md|sql|yaml|yml|go|rs|sh|css|html|xlsx|csv)\b/g;
export function pathsOf(tool) { const set = new Set(); for (const m of (tool.input ?? '').match(PATH_RE) ?? []) set.add(m.split('/').slice(-2).join('/')); return set; }
const EXPLORE = /^(read|grep|glob|ls|cat|sed|head|tail|find|rg|wc|git:(log|show|diff|status)|toolsearch)/;
export const isExplore = (a) => a.split('+').every((x) => EXPLORE.test(x) || /^(grep|head|sed|cat|awk|wc|tail|ls)$/.test(x));
/** Episodes: split at human asks. Each episode = request index range + asks + tools. */
export function episodes(s) {
  const starts = [...new Set(s.asks.filter((a) => !a.interrupt).map((a) => a.reqIdx))].filter((i) => i < s.reqs.length).sort((a, b) => a - b);
  if (!starts.length || starts[0] !== 0) starts.unshift(0);
  return starts.map((st, i) => { const en = (starts[i + 1] ?? s.reqs.length) - 1; const reqs = s.reqs.slice(st, en + 1);
    const ask = s.asks.filter((a) => a.reqIdx === st && !a.interrupt).map((a) => a.text).join('\n');
    const tools = reqs.flatMap((r) => r.tools); const paths = new Set(); for (const t of tools) for (const p of pathsOf(t)) paths.add(p);
    return { i, st, en, ask, reqs, tools, paths, cost: reqs.reduce((a, r) => a + r.cost, 0) }; }).filter((e) => e.en >= e.st);
}
/** A follow-up leans on the conversation: short, anaphoric, or a confirmation. */
export function isFollowUp(ask) { const t = ask.trim().toLowerCase(); if (t.length < 25) return true;
  return /^(yes|no|ok|okay|continue|go|do it|try|and |also |but |so |then |now |what about|why|it |this |that |these |those |same|again|please|great|perfect|thanks|nice|good)/.test(t) || /\b(it|this|that|them|those|above|previous|before)\b/.test(t.slice(0, 60)); }
