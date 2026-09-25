// VENDORED from packages/core|server (dashboard can't take workspace deps on Vercel).
/**
 * The run map — a whole session as a network of the steps it takes and the
 * steps it keeps RETURNING to.
 *
 *   node   a distinct step: tool + what it touched ("read orders.ts", "edit
 *          orders.ts", "tsc", "git:push"). Size = visits; it carries cost,
 *          failures and its kind (explore / edit / verify / deliver / delegate / other).
 *   edge   the run moved from one step to the next (weight = times).
 *   loop   a LOCAL cycle the run went round repeatedly: it came back to a step within
 *          6 steps, and cycles over the same steps were passed ≥3 times. (Whole-graph
 *          strongly connected components are useless here — on a real 1,167-step
 *          session everything was one 138-step "loop", because every long session
 *          eventually returns to grep and cat.) Kinds: `error` (≥20% of visits
 *          failed), `fix` (an edit and a check), `explore` (only reads), `cycle`.
 *   hub    the most-connected steps — what the session revolves around.
 *
 * The layout is a force-directed simulation computed HERE, deterministically
 * (seeded start, fixed iterations), so the same run always draws the same map
 * and the picture is testable. Positions are normalized to [0,1].
 */

import type { Run } from './types.ts';
import { requestsOf } from './rent.ts';
import { actionToken, isReadOnlyCall } from './actions.ts';

export type MapStepKind = 'explore' | 'edit' | 'verify' | 'deliver' | 'delegate' | 'other';

export interface MapNode {
  id: string;
  label: string;
  kind: MapStepKind;
  visits: number;
  errors: number;
  costUsd: number;
  firstAt: number;
  lastAt: number;
  /** Index into `loops`, or -1. */
  loop: number;
  hub: boolean;
  x: number;
  y: number;
}

export interface MapEdge { from: string; to: string; count: number; loop: number }

export interface MapLoop {
  index: number;
  kind: 'cycle' | 'fix' | 'explore' | 'error';
  /** Passes round the loop. */
  passes: number;
  nodes: string[];
  visits: number;
  /** Times the run came back into the loop after leaving one of its steps. */
  returns: number;
  errors: number;
  costUsd: number;
  label: string;
}

export interface RunMap {
  nodes: MapNode[];
  edges: MapEdge[];
  loops: MapLoop[];
  /** Tool calls in the run and how many landed on a step already visited. */
  steps: number;
  revisits: number;
  /** Steps folded into "other" buckets to keep the map readable. */
  folded: number;
}

const VERIFY = /\b(tsc|jest|vitest|pytest|eslint|typecheck|mypy|ruff)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck)\b|\bgo (test|vet|build)\b|\bcargo (test|check|build)\b/;
const DELIVER = /\bgit (commit|push)\b|\bgh pr (create|merge)\b|\b(firebase deploy|vercel|eas (update|build|submit)|gcloud run deploy|npm publish|docker push|kubectl apply|terraform apply)\b/;
const MAX_NODES = 140;
/** A return within this many steps closes a local cycle. */
const WINDOW = 6;
const MAX_LOOPS = 8;

const base = (p: string) => p.split('/').filter(Boolean).slice(-1)[0] ?? p;

function stepOf(t: { name: string; command?: string; filePath?: string; subagent?: string; preview: string }): { id: string; label: string; kind: MapStepKind } {
  const cmd = t.command ?? '';
  if (t.name === 'Agent' || t.name === 'Task') return { id: `delegate:${t.subagent ?? 'agent'}`, label: `delegate → ${t.subagent ?? 'agent'}`, kind: 'delegate' };
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(t.name)) {
    const f = base(t.filePath ?? '');
    return { id: `edit:${f}`, label: `edit ${f}`, kind: 'edit' };
  }
  if (t.name === 'Read' && t.filePath) { const f = base(t.filePath); return { id: `read:${f}`, label: `read ${f}`, kind: 'explore' }; }
  if (t.name === 'Bash') {
    const tok = actionToken({ kind: 'tool_use', name: 'Bash', payload: JSON.stringify({ command: cmd }) });
    if (VERIFY.test(cmd)) { const v = cmd.match(VERIFY)![0].split(/\s+/).slice(-1)[0]; return { id: `verify:${v}`, label: v, kind: 'verify' }; }
    if (DELIVER.test(cmd)) return { id: `deliver:${tok}`, label: tok.replace(/\+/g, ' + '), kind: 'deliver' };
    if (/\bsed\s+-i\b|python3? - <</.test(cmd)) {
      const f = cmd.match(/[\w./-]+\.(ts|tsx|js|py|json|md|go|rs|sql|yaml|yml)\b/)?.[0];
      return { id: `edit:${f ? base(f) : 'script'}`, label: `edit ${f ? base(f) : '(script)'}`, kind: 'edit' };
    }
    const ro = isReadOnlyCall({ kind: 'tool_use', name: 'Bash', payload: JSON.stringify({ command: cmd }) });
    const file = cmd.match(/[\w./-]+\.(ts|tsx|js|py|json|md|go|rs|sql|yaml|yml|txt|log|csv)\b/)?.[0];
    const verb = tok.split('+')[0];
    if (ro && file) return { id: `read:${base(file)}`, label: `read ${base(file)}`, kind: 'explore' };
    return { id: `run:${verb}`, label: verb.replace(/:/g, ' '), kind: ro ? 'explore' : 'other' };
  }
  const tok = actionToken({ kind: 'tool_use', name: t.name, payload: t.preview });
  return { id: `tool:${tok}`, label: tok.replace(/:/g, ' '), kind: /read|get|list|search|find|fetch|query|view/i.test(tok) ? 'explore' : 'other' };
}

/** Deterministic force-directed layout (Fruchterman–Reingold flavour), positions in [0,1]. */
function layout(nodes: MapNode[], edges: MapEdge[]): void {
  const n = nodes.length;
  if (!n) return;
  const pos = nodes.map((_, i) => {
    const a = i * 2.39996323; // golden angle: an even, deterministic spiral start
    const r = 0.45 * Math.sqrt((i + 0.5) / n);
    return { x: 0.5 + r * Math.cos(a), y: 0.5 + r * Math.sin(a) };
  });
  const at = new Map(nodes.map((d, i) => [d.id, i]));
  const deg = new Array<number>(n).fill(0);
  for (const e of edges) { const i = at.get(e.from)!, j = at.get(e.to)!; if (i !== j) { deg[i]++; deg[j]++; } }
  const k = Math.sqrt(1 / n) * 1.25;
  let temp = 0.12;
  for (let it = 0; it < 320; it++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
      const d2 = Math.max(1e-6, dx * dx + dy * dy), d = Math.sqrt(d2);
      const f = (k * k) / d;
      disp[i].x += (dx / d) * f; disp[i].y += (dy / d) * f;
      disp[j].x -= (dx / d) * f; disp[j].y -= (dy / d) * f;
    }
    for (const e of edges) {
      const i = at.get(e.from)!, j = at.get(e.to)!;
      if (i === j) continue;
      const dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
      const d = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy));
      // springs weakened by degree: hubs must not swallow the map into a hairball
      const f = ((d * d) / k) * Math.min(1.5, 0.5 + Math.log2(1 + e.count) * 0.25) / Math.sqrt(Math.max(1, deg[i]) * Math.max(1, deg[j]));
      disp[i].x -= (dx / d) * f; disp[i].y -= (dy / d) * f;
      disp[j].x += (dx / d) * f; disp[j].y += (dy / d) * f;
    }
    for (let i = 0; i < n; i++) {
      disp[i].x += (0.5 - pos[i].x) * 0.08; disp[i].y += (0.5 - pos[i].y) * 0.08; // gravity
      const d = Math.max(1e-9, Math.hypot(disp[i].x, disp[i].y));
      pos[i].x += (disp[i].x / d) * Math.min(d, temp);
      pos[i].y += (disp[i].y / d) * Math.min(d, temp);
    }
    temp *= 0.985;
  }
  // frame on the 3rd–97th percentile so a few far-flung leaves do not squash the map
  const pct = (v: number[], q: number) => { const t = [...v].sort((a, b) => a - b); return t[Math.min(t.length - 1, Math.max(0, Math.round(q * (t.length - 1))))]; };
  const xs = pos.map((p) => p.x), ys = pos.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [pct(xs, 0.03), pct(xs, 0.97), pct(ys, 0.03), pct(ys, 0.97)];
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  nodes.forEach((d, i) => {
    d.x = maxX > minX ? clamp(0.04 + 0.92 * ((pos[i].x - minX) / (maxX - minX))) : 0.5;
    d.y = maxY > minY ? clamp(0.04 + 0.92 * ((pos[i].y - minY) / (maxY - minY))) : 0.5;
  });
}

export function buildRunMap(run: Run): RunMap {
  const R = requestsOf(run);
  // the step sequence, with each request's cost split across its calls
  const seq: { id: string; label: string; kind: MapStepKind; cost: number; error: boolean; at: number }[] = [];
  R.forEach((r, i) => {
    const share = r.tools.length ? r.costUsd / r.tools.length : 0;
    for (const t of r.tools) seq.push({ ...stepOf(t), cost: share, error: !!t.isError, at: i });
  });

  // fold rare steps when the map would be too dense: keep the most visited
  const visits = new Map<string, number>();
  for (const s of seq) visits.set(s.id, (visits.get(s.id) ?? 0) + 1);
  let folded = 0;
  if (visits.size > MAX_NODES) {
    const keep = new Set([...visits.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_NODES - 6).map(([id]) => id));
    for (const s of seq) if (!keep.has(s.id)) { folded++; s.id = `other:${s.kind}`; s.label = `other ${s.kind} steps`; }
  }

  const nodes = new Map<string, MapNode>();
  const seen = new Set<string>();
  let revisits = 0;
  for (const s of seq) {
    const n = nodes.get(s.id) ?? { id: s.id, label: s.label, kind: s.kind, visits: 0, errors: 0, costUsd: 0, firstAt: s.at, lastAt: s.at, loop: -1, hub: false, x: 0.5, y: 0.5 };
    n.visits++; n.costUsd += s.cost; n.lastAt = s.at; if (s.error) n.errors++;
    nodes.set(s.id, n);
    if (seen.has(s.id)) revisits++;
    seen.add(s.id);
  }
  const edgeMap = new Map<string, MapEdge>();
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1].id, b = seq[i].id;
    const key = `${a}→${b}`;
    const e = edgeMap.get(key) ?? { from: a, to: b, count: 0, loop: -1 };
    e.count++; edgeMap.set(key, e);
  }
  const edges = [...edgeMap.values()];

  // loops: local walk cycles — the run returns to a step within WINDOW steps
  const groups: { nodes: Set<string>; passes: number; cost: number; errors: number; visits: number }[] = [];
  const last = new Map<string, number>();
  for (let i = 0; i < seq.length; i++) {
    const id = seq[i].id;
    const prev = last.get(id);
    last.set(id, i);
    if (prev == null || i - prev > WINDOW) continue;
    const span = seq.slice(prev, i);
    const set = new Set(span.map((x) => x.id));
    // merge into the group whose steps overlap most (Jaccard ≥ 0.5), else start one
    let best = -1, bestJ = 0;
    groups.forEach((g, gi) => { let inter = 0; for (const x of set) if (g.nodes.has(x)) inter++; const j = inter / (g.nodes.size + set.size - inter); if (j > bestJ) { bestJ = j; best = gi; } });
    const g = bestJ >= 0.5 ? groups[best] : (groups.push({ nodes: new Set(), passes: 0, cost: 0, errors: 0, visits: 0 }), groups[groups.length - 1]);
    for (const x of set) g.nodes.add(x);
    g.passes++;
    for (const x of seq.slice(prev + 1, i + 1)) { g.cost += x.cost; g.visits++; if (x.error) g.errors++; }
  }
  const loops: MapLoop[] = [];
  for (const g of groups) {
    if (g.passes < 3 || g.nodes.size > 8) continue;
    const members = [...g.nodes].map((id) => nodes.get(id)!);
    const kinds = new Set(members.map((m) => m.kind));
    const kind: MapLoop['kind'] = g.errors >= 0.2 * g.visits ? 'error'
      : kinds.has('edit') && kinds.has('verify') ? 'fix'
      : [...kinds].every((k) => k === 'explore') ? 'explore' : 'cycle';
    const inside = g.nodes;
    let returns = 0;
    for (const e of edges) if (inside.has(e.from) && inside.has(e.to)) returns += e.count;
    const top = [...members].sort((a, b) => b.visits - a.visits).slice(0, 3).map((m) => m.label);
    loops.push({ index: 0, kind, passes: g.passes, nodes: [...g.nodes], visits: g.visits, returns, errors: g.errors, costUsd: g.cost, label: top.join(' ⇄ ') });
  }
  loops.sort((a, b) => b.costUsd - a.costUsd);
  loops.splice(MAX_LOOPS);
  // a step belongs to the most expensive loop it is part of
  for (let i = loops.length - 1; i >= 0; i--) { loops[i].index = i; for (const id of loops[i].nodes) nodes.get(id)!.loop = i; }
  for (const e of edges) { const a = nodes.get(e.from)!, b = nodes.get(e.to)!; if (a.loop >= 0 && a.loop === b.loop) e.loop = a.loop; }

  // hubs: the most connected steps
  const degree = new Map<string, number>();
  for (const e of edges) { degree.set(e.from, (degree.get(e.from) ?? 0) + 1); degree.set(e.to, (degree.get(e.to) ?? 0) + 1); }
  const hubN = Math.min(6, Math.max(1, Math.round(nodes.size * 0.04)));
  for (const [id] of [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, hubN)) nodes.get(id)!.hub = true;

  const list = [...nodes.values()];
  layout(list, edges);
  return { nodes: list, edges, loops, steps: seq.length, revisits, folded };
}
