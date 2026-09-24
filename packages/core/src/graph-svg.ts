/**
 * Run-graph SVG — the canonical DAG made visible: one row per node (kind-colored,
 * canonical label), temporal spine on the left, dataflow edges as arcs on the
 * right. Dataflow arcs are the signal that distinguishes "same steps,
 * coincidence" from "same procedure": output of step i feeding input of step j.
 */

import type { RunGraph } from './types.js';
import { classifyNode, type StepClass } from './taxonomy.js';
import type { ContextPoint, DepositKind } from './rent.js';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ROW_H = 42;
const BOX_W = 620;
const PAD = 12;
const ARC_GAP = 14;

/** Color by optimization class — what the step IS decides what's safe to do to it. */
export const CLASS_STYLE: Record<StepClass, { fill: string; stroke: string; label: string }> = {
  mechanical: { fill: '#e9f9f2', stroke: '#00a37a', label: 'mechanical (scriptable)' },
  cacheable: { fill: '#e8f2ff', stroke: '#0b84ff', label: 'cacheable fetch' },
  generative: { fill: '#f0ecff', stroke: '#7c5cff', label: 'generative (the intelligence)' },
  side_effect: { fill: '#fff4e5', stroke: '#f5a623', label: 'side effect (guard it)' },
};

export interface GraphSvgOptions {
  maxNodes?: number;
}

export function runGraphSvg(graph: RunGraph, options: GraphSvgOptions = {}): string {
  const maxNodes = options.maxNodes ?? 400;
  const nodes = graph.nodes.slice(0, maxNodes);
  const truncated = graph.nodes.length > maxNodes;

  const dataflow = graph.edges.filter(
    (e) => e.type === 'dataflow' && e.from < nodes.length && e.to < nodes.length,
  );
  const arcLanes = Math.min(8, Math.max(1, dataflow.length));
  const width = PAD * 2 + BOX_W + ARC_GAP * (arcLanes + 2);
  const height = PAD * 2 + nodes.length * ROW_H + (truncated ? 30 : 0);

  const parts: string[] = [];

  // Temporal spine
  if (nodes.length > 1) {
    parts.push(
      `<line x1="${PAD + 14}" y1="${PAD + ROW_H / 2}" x2="${PAD + 14}" y2="${PAD + (nodes.length - 1) * ROW_H + ROW_H / 2}" stroke="#d5d5da" stroke-width="2"/>`,
    );
  }

  nodes.forEach((n, i) => {
    const y = PAD + i * ROW_H;
    const style = CLASS_STYLE[classifyNode(n)];
    const stroke = n.isError ? '#e5484d' : style.stroke;
    const fill = n.isError ? '#fdecec' : style.fill;
    const label = n.label.length > 82 ? `${n.label.slice(0, 81)}…` : n.label;
    parts.push(
      `<circle cx="${PAD + 14}" cy="${y + ROW_H / 2}" r="4" fill="${stroke}"/>` +
        `<a href="#node-${i}"><g><rect x="${PAD + 28}" y="${y + 4}" width="${BOX_W}" height="${ROW_H - 10}" rx="7" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>` +
        `<text x="${PAD + 36}" y="${y + ROW_H / 2 + 3}" font-size="11" font-family="ui-monospace,Menlo,monospace" fill="#333">#${i} ${esc(label)}</text></g></a>`,
    );
  });

  // Dataflow arcs on the right edge
  dataflow.forEach((e, idx) => {
    const lane = (idx % arcLanes) + 1;
    const x0 = PAD + 28 + BOX_W;
    const xArc = x0 + ARC_GAP * lane;
    const y1 = PAD + e.from * ROW_H + ROW_H / 2;
    const y2 = PAD + e.to * ROW_H + ROW_H / 2;
    const hue = (e.from * 47) % 360;
    const color = `hsl(${hue} 65% 45%)`;
    parts.push(
      `<path d="M ${x0} ${y1} C ${xArc} ${y1}, ${xArc} ${y2}, ${x0} ${y2}" fill="none" stroke="${color}" stroke-width="1.4" opacity="0.75"/>` +
        `<path d="M ${x0 + 7} ${y2 - 4} L ${x0} ${y2} L ${x0 + 7} ${y2 + 4} Z" fill="${color}" opacity="0.85"/>`,
    );
  });

  if (truncated) {
    parts.push(
      `<text x="${PAD + 28}" y="${height - PAD}" font-size="12" fill="#66666e">… ${graph.nodes.length - maxNodes} more nodes not shown</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;
}

// ---- the context skyline -----------------------------------------------------------


/** Stack order bottom → top; colors picked to read on light and dark backgrounds. */
export const SKYLINE_LAYERS: { key: 'base' | DepositKind; label: string; color: string }[] = [
  { key: 'base', label: 'base (system + tools + CLAUDE.md)', color: '#8a8f98' },
  { key: 'harness', label: 'harness injections', color: '#b9a36b' },
  { key: 'user', label: 'user text', color: '#e0629a' },
  { key: 'tool_result', label: 'tool output', color: '#0b84ff' },
  { key: 'output', label: 'assistant text + edits', color: '#00a37a' },
  { key: 'thinking', label: 'thinking', color: '#7c5cff' },
];

export interface SkylineOptions {
  width?: number;
  height?: number;
  /** Simulated context per request under a policy (simulateCompaction trace). */
  counterfactual?: number[];
  /** Policy threshold line (tokens). */
  threshold?: number;
  /** Downsample to at most this many points (resets always kept). Default 500. */
  maxPoints?: number;
  /** Internal: the original request count when drawing a downsampled series. */
  requestCount?: number;
}

/**
 * Context size per request, stacked by what the context is made of. Area under
 * the curve × read price IS the re-reading bill — the picture of context rent.
 * Resets (compactions) show as cliffs; the dashed line is the same session
 * replayed under the counterfactual policy.
 */
export function contextSkylineSvg(series: ContextPoint[], opts: SkylineOptions = {}): string {
  const W = opts.width ?? 760, H = opts.height ?? 240, L = 48, R = 12, T = 10, B = 26;
  if (series.length < 2) return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"></svg>`;
  const nTotal = series.length;
  const maxPts = opts.maxPoints ?? 500;
  if (nTotal > maxPts) {
    // stride-sample, but keep every reset and the point just before it so cliffs stay sharp
    const stride = Math.ceil(nTotal / maxPts);
    const keep = series.map((p, i) => i % stride === 0 || i === nTotal - 1 || p.reset || series[i + 1]?.reset);
    const cf = opts.counterfactual && opts.counterfactual.length === nTotal ? opts.counterfactual.filter((_, i) => keep[i]) : undefined;
    const sampled = series.filter((_, i) => keep[i]).map((p, j) => ({ ...p, request: j }));
    return contextSkylineSvg(sampled, { ...opts, counterfactual: cf, maxPoints: Infinity, requestCount: nTotal });
  }
  const requestCount = opts.requestCount ?? nTotal;
  const maxY = Math.max(...series.map((p) => p.context), ...(opts.counterfactual ?? [0]), opts.threshold ?? 0) * 1.05;
  const x = (i: number) => L + ((W - L - R) * i) / (series.length - 1);
  const y = (v: number) => T + (H - T - B) * (1 - v / maxY);
  // scale stacked composition to the MEASURED context (attribution splits a measured total)
  const stacks = series.map((p) => {
    const vals = SKYLINE_LAYERS.map((l) => (l.key === 'base' ? p.base : p.kinds[l.key as DepositKind]));
    const sum = vals.reduce((a, b) => a + b, 0) || 1;
    return vals.map((v) => (v * p.context) / sum);
  });
  const layers: string[] = [];
  const cum = series.map(() => 0);
  SKYLINE_LAYERS.forEach((layer, li) => {
    const lower = cum.slice();
    series.forEach((_, i) => { cum[i] += stacks[i][li]; });
    const top = series.map((_, i) => `${x(i).toFixed(1)},${y(cum[i]).toFixed(1)}`);
    const bottom = series.map((_, i) => `${x(i).toFixed(1)},${y(lower[i]).toFixed(1)}`).reverse();
    layers.push(`<polygon points="${[...top, ...bottom].join(' ')}" fill="${layer.color}" fill-opacity="0.78"><title>${layer.label}</title></polygon>`);
  });
  const ticks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const v = (maxY / 1.05) * (i / 4);
    ticks.push(`<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="currentColor" stroke-opacity="0.12"/>`
      + `<text x="${L - 6}" y="${(y(v) + 3).toFixed(1)}" font-size="10" text-anchor="end" fill="currentColor" fill-opacity="0.6">${Math.round(v / 1000)}k</text>`);
  }
  const resets = series.filter((p) => p.reset).map((p) => `<line x1="${x(p.request).toFixed(1)}" x2="${x(p.request).toFixed(1)}" y1="${T}" y2="${H - B}" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="2 3"><title>compaction / reset</title></line>`);
  const cf = opts.counterfactual && opts.counterfactual.length === series.length
    ? `<polyline points="${opts.counterfactual.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5 4"><title>same session replayed under the policy</title></polyline>`
    : '';
  const thr = opts.threshold
    ? `<line x1="${L}" x2="${W - R}" y1="${y(opts.threshold).toFixed(1)}" y2="${y(opts.threshold).toFixed(1)}" stroke="#eb6834" stroke-opacity="0.8" stroke-dasharray="1 3"><title>compaction threshold</title></line>`
    : '';
  const axis = `<text x="${L}" y="${H - 8}" font-size="10" fill="currentColor" fill-opacity="0.6">request 1</text><text x="${W - R}" y="${H - 8}" font-size="10" text-anchor="end" fill="currentColor" fill-opacity="0.6">request ${requestCount}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Context size per request, stacked by content">${ticks.join('')}${layers.join('')}${resets.join('')}${thr}${cf}${axis}</svg>`;
}
