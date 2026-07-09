/** Landing-page content + computed geometry, ported from the design handoff. */

export interface Scheme { bg: string; border: string; text: string; dot: string }
export const SCHEMES: Record<string, Scheme> = {
  purple: { bg: 'oklch(0.97 0.02 290)', border: 'oklch(0.85 0.06 290)', text: 'oklch(0.42 0.12 290)', dot: 'oklch(0.55 0.16 290)' },
  blue: { bg: 'oklch(0.97 0.02 250)', border: 'oklch(0.85 0.05 250)', text: 'oklch(0.42 0.12 250)', dot: 'oklch(0.55 0.15 250)' },
  green: { bg: 'oklch(0.97 0.03 150)', border: 'oklch(0.82 0.08 150)', text: 'oklch(0.4 0.13 150)', dot: 'oklch(0.55 0.15 150)' },
  gray: { bg: 'oklch(0.97 0.005 260)', border: 'oklch(0.87 0.005 260)', text: 'oklch(0.4 0.01 260)', dot: 'oklch(0.6 0.01 260)' },
};

const PROBLEM_HUES = [20, 60, 290, 250, 150, 320];
export const problems = [
  '01. High token costs',
  '02. Long execution times',
  '03. Large context windows',
  '04. Duplicate reasoning',
  '05. Repeated repository exploration',
  '06. No accumulated knowledge between runs',
].map((t, i) => {
  const hue = PROBLEM_HUES[i % PROBLEM_HUES.length];
  return {
    num: t.slice(0, 2), text: t.slice(4),
    bg: `oklch(0.97 0.025 ${hue})`, border: `oklch(0.87 0.06 ${hue})`, numColor: `oklch(0.5 0.15 ${hue})`,
  };
});

export const engineParts = [
  { name: 'Pattern Detection', desc: 'Compares executions to find repeated workflows.' },
  { name: 'Determinism Engine', desc: 'Scores every node 0–100 on stability and repeat frequency.' },
  { name: 'Tool Synthesizer', desc: 'Turns repeated reasoning into executable, registered tools.' },
  { name: 'Model Optimizer', desc: 'Routes each step to the right-sized model.' },
  { name: 'Context Optimizer', desc: 'Strips duplicated context and compresses history.' },
  { name: 'Knowledge Graph Builder', desc: 'Builds a semantic map of the repository over time.' },
  { name: 'Cache Generator', desc: 'Caches deterministic outputs and invalidates on change.' },
  { name: 'Validation Engine', desc: 'Replays every optimization against history before activation.' },
];

export const scoreBands = [
  { range: '90–100', title: 'Generate deterministic replacement', desc: 'Reasoning is replaced with a compiled tool or rule.', color: 'oklch(0.72 0.15 150)' },
  { range: '70–90', title: 'Use a smaller model or cache', desc: 'Routed to a cheaper model, or served from cache.', color: 'oklch(0.78 0.13 85)' },
  { range: 'Below 70', title: 'Keep using the LLM', desc: 'Too much variance to safely automate — no change.', color: 'oklch(0.65 0.02 260)' },
];

export const installTabs = [
  { key: 'cli', label: 'CLI' },
  { key: 'docker', label: 'Docker Sidecar' },
  { key: 'sdk', label: 'SDK' },
  { key: 'proxy', label: 'Proxy' },
];
export const INSTALL_CODE: Record<string, string> = {
  cli: '$ curl https://optimizer.ai/install | sh\n$ optimizer init\n\n> Detected: Docker, Claude Code, Node\n> Installed adapters for: claude-code, node',
  docker: 'services:\n  app:\n    image: your-app\n  optimizer:\n    image: optimizer/sidecar\n    environment:\n      - TARGET=app:3000',
  sdk: '# Python\nimport optimizer\noptimizer.init()\n\n// Node\nimport optimizer from "optimizer"\noptimizer.init()',
  proxy: '# Before\nAPI_BASE=https://api.openai.com\n\n# After\nAPI_BASE=http://localhost:8080\n# Optimizer proxies and optimizes traffic transparently',
};

export const originalStats = [
  { value: '28', label: 'steps' }, { value: '189K', label: 'tokens' }, { value: '14.2s', label: '' }, { value: '$2.31', label: '' },
];
export const optimizedStats = [
  { value: '9', label: 'steps' }, { value: '45K', label: 'tokens' }, { value: '3.1s', label: '' }, { value: '$0.42', label: '' },
];

/** Radial "live call graph" geometry (7 nodes on a ring, heat-colored by call count). */
const RUNTIME_NODES = [
  { label: 'Repo Search', count: 184 },
  { label: 'AST Parse', count: 142 },
  { label: 'File Read', count: 97 },
  { label: 'Context Build', count: 61 },
  { label: 'Planner Call', count: 34 },
  { label: 'Knowledge Graph', count: 19 },
  { label: 'Cache Hit', count: 8 },
];
function heatColorFor(count: number, max: number): string {
  const t = Math.min(1, count / max);
  const hue = 250 - t * 210;
  const chroma = 0.04 + t * 0.16;
  const light = 0.6 - t * 0.08;
  return `oklch(${light.toFixed(2)} ${chroma.toFixed(2)} ${hue.toFixed(0)})`;
}
export function buildRuntimeGraph() {
  const cx = 50, cy = 50, R = 38;
  const max = Math.max(...RUNTIME_NODES.map((n) => n.count));
  const n = RUNTIME_NODES.length;
  const nodes = RUNTIME_NODES.map((d, i) => {
    const angle = i * (360 / n) - 90;
    const rad = (angle * Math.PI) / 180;
    const heatColor = heatColorFor(d.count, max);
    return {
      label: d.label, count: d.count,
      left: `${(cx + R * Math.cos(rad)).toFixed(1)}%`,
      top: `${(cy + R * Math.sin(rad)).toFixed(1)}%`,
      heatColor, glow: d.count / max > 0.55, angle,
    };
  });
  const edges = nodes.map((node, i) => ({
    rot: `${node.angle}deg`, heatColor: node.heatColor,
    flowDur: `${(1.4 + (1 - node.count / max) * 1.4).toFixed(1)}s`,
    flowDelay: `${(i * 0.25).toFixed(2)}s`,
  }));
  return { nodes, edges };
}
