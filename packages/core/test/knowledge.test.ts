import { describe, expect, it } from 'vitest';
import {
  analyzeDeterminism,
  buildKnowledgeGraph,
  buildRunGraph,
  parseTranscript,
  renderKnowledgeBundle,
  renderSlimContext,
  type Run,
} from '../src/index.js';
import { synthTranscript, type SynthRunSpec } from './helpers.js';

function runsOf(specs: SynthRunSpec[]): Run[] {
  return specs.map((s) => {
    const run = parseTranscript(synthTranscript(s));
    if (!run) throw new Error(`fixture produced no run: ${s.sessionId}`);
    return run;
  });
}

/** An agent that re-discovers the same repo facts every run, then does real work. */
function repoExplorerSpecs(n: number): SynthRunSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: `explore-${i}`,
    cwd: '/work/agents/repo-explorer',
    prompt: `Add an endpoint for feature-${i}.`,
    tools: [
      { name: 'Glob', input: { pattern: 'src/**/*.ts' }, result: 'src/index.ts\nsrc/routes.ts\nsrc/db.ts' },
      { name: 'Grep', input: { pattern: 'registerRoute', path: 'src' }, result: 'src/routes.ts:12\nsrc/routes.ts:48' },
      { name: 'Read', input: { file_path: 'package.json' }, result: '{"name":"shop-api","version":"2.1.0"}' },
      { name: 'Write', input: { file_path: `src/feature_${i}.ts`, content: `export const f${i} = 1;` }, result: 'File created' },
    ],
    finalText: `Added feature-${i} endpoint.`,
    startedAt: `2026-07-0${(i % 5) + 1}T10:00:00.000Z`,
  }));
}

/** Stable questions, VARYING answers — no knowledge to keep. */
function deployCheckSpecs(n: number): SynthRunSpec[] {
  return Array.from({ length: n }, (_, i) => {
    const svc = `billing-api-service-${String(i).padStart(2, '0')}`;
    return {
      sessionId: `deploy-${i}`,
      cwd: '/work/agents/deploy-check',
      prompt: 'Run the daily health check.',
      tools: [
        { name: 'Read', input: { file_path: '/app/config/service.json' }, result: `{"service":"${svc}"}` },
        { name: 'Bash', input: { command: `curl -s https://internal.example.com/health/${svc}` }, result: 'status: healthy' },
      ],
      finalText: `Service ${svc} is healthy.`,
      startedAt: `2026-07-0${(i % 5) + 1}T10:00:00.000Z`,
    };
  });
}

/** Agent that lists a dir AND reads a file that listing enumerated — so the
 *  listing fact and the read fact share an entity (the connection). */
function connectedSpecs(n: number): SynthRunSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: `conn-${i}`,
    cwd: '/work/agents/linker',
    prompt: `Task ${i}.`,
    tools: [
      { name: 'Glob', input: { pattern: 'src/**/*.ts' }, result: 'src/index.ts\nsrc/routes.ts\nsrc/db.ts' },
      { name: 'Read', input: { file_path: 'src/routes.ts' }, result: 'export function registerRoute() { return 1; }' },
      { name: 'Read', input: { file_path: 'package.json' }, result: '{"name":"linker","version":"1.0.0"}' },
    ],
    finalText: `Done ${i}.`,
    startedAt: `2026-07-0${(i % 5) + 1}T10:00:00.000Z`,
  }));
}

describe('knowledge graph — entities + connections', () => {
  it('builds entity nodes with an `about` edge from every fact', () => {
    const [kg] = buildKnowledgeGraph(analyzeDeterminism(runsOf(connectedSpecs(10)).map(buildRunGraph)));
    const facts = kg.nodes.filter((n) => n.type === 'fact');
    const entities = kg.nodes.filter((n) => n.type === 'entity');
    expect(facts.length).toBeGreaterThanOrEqual(3);
    expect(entities.length).toBeGreaterThanOrEqual(3);
    for (const f of facts) {
      expect(kg.edges.some((e) => e.from === f.id && e.rel === 'about')).toBe(true);
    }
  });

  it('connects a listing to the file it enumerates through a shared entity', () => {
    const [kg] = buildKnowledgeGraph(analyzeDeterminism(runsOf(connectedSpecs(10)).map(buildRunGraph)));
    const routes = kg.nodes.find((n) => n.type === 'entity' && n.label.includes('routes.ts'));
    expect(routes).toBeDefined();
    const into = kg.edges.filter((e) => e.to === routes!.id);
    // read routes.ts is ABOUT it; the glob LISTS it — two facts, one hub.
    expect(into.some((e) => e.rel === 'about')).toBe(true);
    expect(into.some((e) => e.rel === 'lists')).toBe(true);
    expect(routes!.degree).toBeGreaterThanOrEqual(2);
  });

  it('no facts → empty graph (gate stays closed)', () => {
    const [kg] = buildKnowledgeGraph(analyzeDeterminism(runsOf(deployCheckSpecs(12)).map(buildRunGraph)));
    expect(kg.nodes).toHaveLength(0);
    expect(kg.edges).toHaveLength(0);
  });

  it('renders an OKF bundle: index.md + interlinked concept files', () => {
    const [kg] = buildKnowledgeGraph(analyzeDeterminism(runsOf(connectedSpecs(10)).map(buildRunGraph)));
    const files = renderKnowledgeBundle(kg, { generatedAt: '2026-07-12T00:00:00.000Z' });

    // index.md is the entry point, with OKF `type: index` frontmatter.
    expect(files[0].path).toBe('knowledge/index.md');
    expect(files[0].content).toMatch(/^---\ntype: index/);
    expect(files[0].content).toContain('look up the concept you need');
    expect(files[0].content).toMatch(/\]\(\w+\/[\w-]+\.md\)/); // links to concepts

    // every concept file carries the one required OKF field, `type`.
    const concepts = files.slice(1);
    expect(concepts.length).toBeGreaterThan(0);
    for (const c of concepts) expect(c.content).toMatch(/^---\ntype: \w+/);

    // the graph's edges become OKF interlinks between concept files.
    expect(concepts.some((c) => /\]\(\.\.\/\w+\/[\w-]+\.md\)/.test(c.content))).toBe(true);
  });

  it('empty graph → no OKF files', () => {
    const [kg] = buildKnowledgeGraph(analyzeDeterminism(runsOf(deployCheckSpecs(12)).map(buildRunGraph)));
    expect(renderKnowledgeBundle(kg)).toHaveLength(0);
  });

  it('renders slim context: highest-value facts, under budget, directive', () => {
    const [kg] = buildKnowledgeGraph(analyzeDeterminism(runsOf(repoExplorerSpecs(10)).map(buildRunGraph)));
    const slim = renderSlimContext(kg, { tokenBudget: 1200 });
    expect(slim.markdown).toContain('do NOT re-run');
    expect(slim.factsIncluded).toBeGreaterThan(0);
    expect(slim.estTokens).toBeLessThanOrEqual(1200); // budget respected
    expect(slim.markdown).toContain('package.json'); // the known file is pushed
  });

  it('a tiny budget still respects the cap (pushes only what fits)', () => {
    const [kg] = buildKnowledgeGraph(analyzeDeterminism(runsOf(repoExplorerSpecs(10)).map(buildRunGraph)));
    const slim = renderSlimContext(kg, { tokenBudget: 40 });
    expect(slim.estTokens).toBeLessThanOrEqual(40);
    expect(slim.factsIncluded).toBeLessThanOrEqual(kg.entries.length);
  });

  it('no facts → empty slim context', () => {
    const [kg] = buildKnowledgeGraph(analyzeDeterminism(runsOf(deployCheckSpecs(12)).map(buildRunGraph)));
    expect(renderSlimContext(kg).markdown).toBe('');
    expect(renderSlimContext(kg).factsIncluded).toBe(0);
  });
});

describe('knowledge graph mining', () => {
  it('turns stable exploration into typed facts and gates on coverage', () => {
    const analyses = analyzeDeterminism(runsOf(repoExplorerSpecs(10)).map(buildRunGraph));
    const [kg] = buildKnowledgeGraph(analyses);

    expect(kg.agentId).toBe('repo-explorer');
    expect(kg.worthIt).toBe(true);
    expect(kg.coverage).toBe(1); // every exploration lookup is answerable
    expect(kg.entries).toHaveLength(3);
    expect(kg.entries.map((e) => e.kind).sort()).toEqual(['file', 'listing', 'search']);

    const file = kg.entries.find((e) => e.kind === 'file')!;
    expect(file.key).toContain('package.json');
    expect(file.value).toContain('shop-api');
    expect(file.support).toBe(10);
    expect(file.confidence).toBeGreaterThanOrEqual(50);

    const search = kg.entries.find((e) => e.kind === 'search')!;
    expect(search.value).toContain('src/routes.ts:12');
  });

  it('varying answers produce no facts — the gate stays closed', () => {
    const analyses = analyzeDeterminism(runsOf(deployCheckSpecs(12)).map(buildRunGraph));
    const [kg] = buildKnowledgeGraph(analyses);
    expect(kg.entries).toHaveLength(0);
    expect(kg.worthIt).toBe(false);
    expect(kg.explorationSteps).toBeGreaterThan(0); // it explored — nothing was stable
  });

  it('entry ids are stable across windows', () => {
    const a = buildKnowledgeGraph(analyzeDeterminism(runsOf(repoExplorerSpecs(10)).map(buildRunGraph)));
    const b = buildKnowledgeGraph(analyzeDeterminism(runsOf(repoExplorerSpecs(6)).map(buildRunGraph)));
    const idsA = a[0].entries.map((e) => e.id).sort();
    const idsB = b[0].entries.map((e) => e.id).sort();
    expect(idsA).toEqual(idsB);
  });
});
