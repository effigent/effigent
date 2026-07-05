/**
 * Run-graph SVG — the canonical DAG made visible: one row per node (kind-colored,
 * canonical label), temporal spine on the left, dataflow edges as arcs on the
 * right. Dataflow arcs are the signal that distinguishes "same steps,
 * coincidence" from "same procedure": output of step i feeding input of step j.
 */

import type { RunGraph } from './types.js';
import { classifyNode, type StepClass } from './taxonomy.js';

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
