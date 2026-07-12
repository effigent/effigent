/**
 * Knowledge graph — the agent's re-discovered world, materialized.
 *
 * Agents burn tokens re-learning the same facts every run: the same globs,
 * the same greps, the same config reads. The v3 lattice already knows which
 * of those lookups are STABLE (mechanical/cacheable calls whose answers agree
 * across runs) — this module turns them into queryable facts:
 *
 *   "what does src/**⁄*.ts contain?"  → the listing   (kind: listing)
 *   "where is registerRoute used?"    → the matches   (kind: search)
 *   "what's in package.json?"         → the content   (kind: file)
 *   "what did that GET return?"       → the response  (kind: fetch)
 *
 * Injected into the agent (skill bundle / CLAUDE.md), these replace the
 * exploration prelude: the agent READS the fact instead of re-running the
 * lookup — fewer greps, faster context. `worthIt` is the honest gate: a KG is
 * only emitted when stable facts actually cover a meaningful share of the
 * agent's exploration traffic.
 */

import { createHash } from 'node:crypto';
import type { ClusterAnalysis, NodeAnalysis } from './determinism.js';

export type KnowledgeKind = 'file' | 'search' | 'listing' | 'fetch' | 'value';

export interface KnowledgeEntry {
  /** Stable across windows: hash(agent | canonical question). */
  id: string;
  kind: KnowledgeKind;
  tool: string;
  /** The question the agent keeps asking (tool arguments). */
  key: string;
  /** The stable answer (already redacted at ingest; truncated for transport). */
  value: string;
  /** Runs that asked this question. */
  support: number;
  /** Share of those runs that got the modal answer (0–1). */
  agreement: number;
  /** Wilson lower bound of the answer's stability, 0–100. */
  confidence: number;
  /** Measured cost of asking, per run (question + answer steps). */
  estUsdPerRun: number;
  agentId: string;
  evidenceRunIds: string[];
}

export type EntityType = 'file' | 'dir' | 'glob' | 'url' | 'symbol';

/** A node in the connected knowledge graph: either a mined fact, or an entity
 *  (a file/dir/glob/url/symbol) that one or more facts are ABOUT or MENTION. */
export interface KnowledgeNode {
  id: string;
  type: 'fact' | 'entity';
  label: string;
  /** fact nodes */
  kind?: KnowledgeKind;
  factId?: string;
  /** entity nodes */
  entityType?: EntityType;
  /** connection count (filled after assembly) — the explorer sizes hubs by it. */
  degree: number;
}
export interface KnowledgeEdge {
  from: string;
  to: string;
  /** about: the fact's primary subject · lists: a listing/search that enumerates
   *  the entity · mentions: the entity appears in the fact's answer. */
  rel: 'about' | 'lists' | 'mentions';
}

export interface KnowledgeGraphReport {
  agentId: string;
  runCount: number;
  entries: KnowledgeEntry[];
  /** Connected graph over the facts: entities are the hubs that link facts, so
   *  an agent (or the explorer) can look up an entity and traverse to every
   *  fact about it, and from a listing to the files it enumerates. */
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  /** Support-weighted count of mechanical/cacheable lookups in the window. */
  explorationSteps: number;
  /** Of those, how many a KG fact now answers. */
  coveredSteps: number;
  /** coveredSteps ÷ explorationSteps — the "fewer greps" measure. */
  coverage: number;
  /** Σ entry cost — what reading facts instead would remove, per run. */
  estUsdPerRun: number;
  /** Emit/inject only when the graph actually pays for its context space. */
  worthIt: boolean;
}

export interface KnowledgeOptions {
  /** Result-value agreement required to call an answer stable (0–100). */
  minScore?: number;
  /** Wilson confidence floor (0–100). */
  minConfidence?: number;
  /** worthIt gates. */
  minEntries?: number;
  minCoverage?: number;
  /** Truncation for stored answers. */
  maxValueChars?: number;
  maxEntries?: number;
}

const BASH_SEARCH = /^\s*(grep|rg|ag)\b/;
const BASH_LISTING = /^\s*(ls|find|tree|glob)\b/;
const BASH_FILE = /^\s*(cat|head|tail|less)\b/;

function kindOf(tool: string, rawArgs: string): KnowledgeKind {
  const t = tool.toLowerCase();
  if (t === 'read' || t === 'notebookread') return 'file';
  if (t === 'grep') return 'search';
  if (t === 'glob' || t === 'ls') return 'listing';
  if (t.includes('fetch') || t.includes('search') && t.startsWith('web')) return 'fetch';
  if (t === 'websearch' || t === 'web_search' || t === 'webfetch' || t === 'web_fetch') return 'fetch';
  if (t === 'bash' || t === 'shell') {
    try {
      const cmd = (JSON.parse(rawArgs) as { command?: string }).command ?? '';
      if (BASH_SEARCH.test(cmd)) return 'search';
      if (BASH_LISTING.test(cmd)) return 'listing';
      if (BASH_FILE.test(cmd)) return 'file';
    } catch {
      /* raw payload */
    }
  }
  return 'value';
}

function toolNameOf(structLabel: string): string {
  return structLabel.startsWith('tool:') ? structLabel.slice(5).split('(')[0] : structLabel;
}

/* ---- graph assembly: entities + derivation edges -------------------------
 * Facts alone are a list. Entities (the files/dirs/globs/urls/symbols the facts
 * are ABOUT) are the hubs that connect them: a directory listing LISTS the files
 * that other facts READ; a grep is ABOUT a symbol another fact defines. Those
 * connections are what let an agent look up an entity and traverse to every
 * fact about it — and they become the interlinks in the emitted OKF bundle.  */

const norm = (s: string): string => s.trim().replace(/^\.\//, '').replace(/^["'`]+|["'`]+$/g, '');
export const entitySlug = (s: string): string =>
  norm(s).toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

function parseArgs(key: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(key) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const RE_URL = /(https?:\/\/[^\s"'`]+)/g;
const RE_PATH =
  /((?:\.?\/)?[\w.@-]+(?:\/[\w.@-]+)+|\b[\w-]+\.(?:ts|tsx|js|jsx|json|py|md|go|rs|ya?ml|toml|sql|sh|css|html|txt|lock)\b)/g;

interface Ent {
  slug: string;
  label: string;
  etype: EntityType;
}
const mkEnt = (raw: string, etype: EntityType): Ent | null => {
  const label = norm(raw).slice(0, 64);
  const slug = entitySlug(raw);
  return slug ? { slug, label, etype } : null;
};

/** The single thing a fact is primarily ABOUT (from its tool arguments). */
function subjectOf(e: KnowledgeEntry): Ent | null {
  const a = parseArgs(e.key);
  const s = (k: string) => (typeof a?.[k] === 'string' ? (a[k] as string) : undefined);
  const firstPath = () => e.key.match(RE_PATH)?.[0];
  switch (e.kind) {
    case 'file':
      return mkEnt(s('file_path') ?? s('path') ?? firstPath() ?? '', 'file');
    case 'listing': {
      const g = s('pattern') ?? s('glob') ?? s('path') ?? firstPath() ?? '';
      return mkEnt(g, g.includes('*') ? 'glob' : 'dir');
    }
    case 'search':
      return mkEnt(s('pattern') ?? e.key.match(/["'`]([^"'`]{2,})["'`]/)?.[1] ?? '', 'symbol');
    case 'fetch':
      return mkEnt(s('url') ?? e.key.match(RE_URL)?.[0] ?? '', 'url');
    default:
      return mkEnt(firstPath() ?? '', 'file');
  }
}

/** Entities named in a fact's ANSWER — a listing enumerates files, a read
 *  mentions paths/urls. These become `lists`/`mentions` edges when they resolve
 *  to an entity some other fact is about. */
function mentionsOf(e: KnowledgeEntry): Ent[] {
  const out: Ent[] = [];
  const seen = new Set<string>();
  const add = (raw: string, etype: EntityType) => {
    const ent = mkEnt(raw, etype);
    if (ent && !seen.has(ent.slug)) {
      seen.add(ent.slug);
      out.push(ent);
    }
  };
  for (const m of e.value.matchAll(RE_URL)) add(m[1], 'url');
  for (const m of e.value.matchAll(RE_PATH)) add(m[0], 'file');
  return out.slice(0, 24);
}

function buildFactGraph(entries: KnowledgeEntry[]): { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] } {
  const nodes = new Map<string, KnowledgeNode>();
  const edges: KnowledgeEdge[] = [];
  const subjectByFact = new Map<string, string>(); // factId -> entity slug
  const entityIdBySlug = new Map<string, string>();
  const factLabel = (e: KnowledgeEntry) => {
    const subj = subjectOf(e);
    return `${e.kind}: ${subj?.label ?? e.tool}`;
  };
  const ensureEntity = (ent: Ent): string => {
    const id = `entity:${ent.slug}`;
    if (!nodes.has(id)) nodes.set(id, { id, type: 'entity', label: ent.label, entityType: ent.etype, degree: 0 });
    entityIdBySlug.set(ent.slug, id);
    return id;
  };

  // Fact nodes + `about` edges to their subject entity.
  for (const e of entries) {
    const fid = `fact:${e.id}`;
    nodes.set(fid, { id: fid, type: 'fact', label: factLabel(e), kind: e.kind, factId: e.id, degree: 0 });
    const subj = subjectOf(e);
    if (subj) {
      edges.push({ from: fid, to: ensureEntity(subj), rel: 'about' });
      subjectByFact.set(e.id, subj.slug);
    }
  }

  // Derivation edges: a fact's answer names an entity ANOTHER fact is about →
  // connect the fact to that entity (matched exactly or by basename).
  const basenameToSlug = new Map<string, string>();
  for (const slug of entityIdBySlug.keys()) {
    const base = slug.split('/').pop();
    if (base && base !== slug && !basenameToSlug.has(base)) basenameToSlug.set(base, slug);
  }
  for (const e of entries) {
    const fid = `fact:${e.id}`;
    const ownSlug = subjectByFact.get(e.id);
    for (const m of mentionsOf(e)) {
      let targetSlug = entityIdBySlug.has(m.slug) ? m.slug : undefined;
      if (!targetSlug) {
        const base = m.slug.split('/').pop();
        if (base) targetSlug = basenameToSlug.get(base);
      }
      if (!targetSlug || targetSlug === ownSlug) continue; // unknown, or its own subject
      edges.push({ from: fid, to: `entity:${targetSlug}`, rel: e.kind === 'listing' || e.kind === 'search' ? 'lists' : 'mentions' });
    }
  }

  // De-dup edges, then compute node degree.
  const seen = new Set<string>();
  const deduped = edges.filter((x) => {
    const k = `${x.from}|${x.to}|${x.rel}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  for (const x of deduped) {
    const a = nodes.get(x.from);
    const b = nodes.get(x.to);
    if (a) a.degree++;
    if (b) b.degree++;
  }
  return { nodes: [...nodes.values()], edges: deduped };
}

/** Build per-agent knowledge graphs from analyzed clusters (same input as
 *  synthesis — callers already have `analyzeDeterminism` output). */
export function buildKnowledgeGraph(
  analyses: ClusterAnalysis[],
  opts: KnowledgeOptions = {},
): KnowledgeGraphReport[] {
  const minScore = opts.minScore ?? 90;
  const minConfidence = opts.minConfidence ?? 50;
  const minEntries = opts.minEntries ?? 3;
  const minCoverage = opts.minCoverage ?? 0.2;
  const maxValueChars = opts.maxValueChars ?? 600;
  const maxEntries = opts.maxEntries ?? 40;

  const byAgent = new Map<string, ClusterAnalysis[]>();
  for (const a of analyses) {
    (byAgent.get(a.agentId) ?? byAgent.set(a.agentId, []).get(a.agentId)!).push(a);
  }

  const reports: KnowledgeGraphReport[] = [];
  for (const [agentId, agentAnalyses] of byAgent) {
    const merged = new Map<string, KnowledgeEntry>();
    let exploration = 0;
    let covered = 0;
    let runCount = 0;

    for (const analysis of agentAnalyses) {
      runCount += analysis.runCount;
      const medoid = analysis.alignment.cluster.medoid;
      const nodes = analysis.nodes;

      for (let i = 0; i < nodes.length; i++) {
        const use: NodeAnalysis = nodes[i];
        if (use.kind !== 'tool_use') continue;
        if (!(use.class === 'mechanical' || use.class === 'cacheable')) continue;
        exploration += use.support;

        const res = nodes[i + 1];
        if (!res || res.kind !== 'tool_result') continue;
        // A fact needs BOTH a stable question and a stable answer.
        if (use.score < minScore || res.score < minScore) continue;
        if (res.confidence < minConfidence) continue;

        covered += use.support;
        const tool = toolNameOf(use.structLabel);
        const keyRaw = medoid.nodes[use.index]?.raw ?? '';
        const id = createHash('sha256')
          .update(`${agentId}|kg|${use.label}`)
          .digest('hex')
          .slice(0, 12);
        const entry: KnowledgeEntry = {
          id,
          kind: kindOf(tool, keyRaw),
          tool,
          key: keyRaw.slice(0, 300),
          value: (medoid.nodes[res.index]?.raw ?? '').slice(0, maxValueChars),
          support: use.support,
          agreement: Math.round((res.score / 100) * 100) / 100,
          confidence: res.confidence,
          estUsdPerRun: Math.round((use.estUsdPerRun + res.estUsdPerRun) * 10000) / 10000,
          agentId,
          evidenceRunIds: analysis.runIds.slice(0, 5),
        };
        const prev = merged.get(id);
        if (prev) {
          // Clusters partition runs, so supports add; keep the stronger answer.
          prev.support += entry.support;
          prev.agreement = Math.max(prev.agreement, entry.agreement);
          prev.confidence = Math.min(prev.confidence, entry.confidence);
          prev.estUsdPerRun = Math.round(((prev.estUsdPerRun + entry.estUsdPerRun) / 2) * 10000) / 10000;
          prev.evidenceRunIds = [...new Set([...prev.evidenceRunIds, ...entry.evidenceRunIds])].slice(0, 5);
        } else {
          merged.set(id, entry);
        }
      }
    }

    const entries = [...merged.values()]
      .sort((a, b) => b.support * b.estUsdPerRun - a.support * a.estUsdPerRun || b.support - a.support)
      .slice(0, maxEntries);
    const coverage = exploration === 0 ? 0 : covered / exploration;
    const { nodes, edges } = buildFactGraph(entries);
    reports.push({
      agentId,
      runCount,
      entries,
      nodes,
      edges,
      explorationSteps: exploration,
      coveredSteps: covered,
      coverage: Math.round(coverage * 100) / 100,
      estUsdPerRun: Math.round(entries.reduce((s, e) => s + e.estUsdPerRun, 0) * 10000) / 10000,
      worthIt: entries.length >= minEntries && coverage >= minCoverage,
    });
  }

  return reports.sort((a, b) => b.estUsdPerRun - a.estUsdPerRun);
}

/* ---- OKF emission --------------------------------------------------------
 * Render a knowledge graph as an Open Knowledge Format bundle (Google Cloud,
 * 2026): a directory of markdown "concept" files with YAML frontmatter,
 * interlinked with markdown links so the directory *is* the graph. The agent
 * reads index.md, finds the concept it needs, and follows links to related
 * concepts — instead of re-running the lookup. Vendor-neutral + navigable.  */

export interface OkfFile {
  path: string;
  content: string;
}

const flatName = (s: string): string =>
  s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'concept';

function frontmatter(fm: Record<string, string | string[] | undefined>): string {
  const out = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) out.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`);
    else out.push(`${k}: ${/[:#\n]/.test(v) ? JSON.stringify(v) : v}`);
  }
  out.push('---');
  return out.join('\n');
}

/** OKF bundle for one agent's knowledge graph. `index.md` first. */
export function renderKnowledgeBundle(
  report: KnowledgeGraphReport,
  opts: { generatedAt?: string } = {},
): OkfFile[] {
  const { nodes, edges, entries, agentId, runCount } = report;
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const entities = nodes.filter((n) => n.type === 'entity');
  if (entities.length === 0) return [];

  const conceptPath = (n: KnowledgeNode) => `${n.entityType}/${flatName(`${n.entityType}-${n.label}`)}.md`;
  const pathById = new Map(entities.map((n) => [n.id, conceptPath(n)] as const));

  // facts about each entity, and this-fact's subject (for relating entities).
  const factsOf = new Map<string, KnowledgeEntry[]>();
  const subjectOfFactNode = new Map<string, string>();
  for (const e of edges) {
    if (e.rel !== 'about') continue;
    subjectOfFactNode.set(e.from, e.to);
    const entry = entryById.get(nodeById.get(e.from)?.factId ?? '');
    if (entry) (factsOf.get(e.to) ?? factsOf.set(e.to, []).get(e.to)!).push(entry);
  }
  // entity → entity relations (a fact about A lists/mentions entity B).
  const out = new Map<string, { to: string; rel: KnowledgeEdge['rel'] }[]>();
  const inc = new Map<string, { from: string; rel: KnowledgeEdge['rel'] }[]>();
  for (const e of edges) {
    if (e.rel === 'about') continue;
    const src = subjectOfFactNode.get(e.from);
    if (!src || src === e.to) continue;
    (out.get(src) ?? out.set(src, []).get(src)!).push({ to: e.to, rel: e.rel });
    (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push({ from: src, rel: e.rel });
  }

  const files: OkfFile[] = [];
  for (const ent of entities) {
    const p = pathById.get(ent.id)!;
    const facts = factsOf.get(ent.id) ?? [];
    const kinds = [...new Set(facts.map((f) => f.kind))];
    const support = facts.reduce((m, f) => Math.max(m, f.support), 0);
    const link = (id: string) => {
      const t = nodeById.get(id);
      const tp = pathById.get(id);
      return t && tp ? `[${t.label}](../${tp})` : null;
    };
    const body: string[] = [
      frontmatter({
        type: ent.entityType!,
        title: ent.label,
        description: facts.length
          ? `Stable ${kinds.join('/')} known across ${support} run(s).`
          : `Referenced by ${ent.degree} fact(s); content not captured.`,
        tags: [`agent:${agentId}`, facts.length ? 'stable' : 'referenced'],
        timestamp: opts.generatedAt,
      }),
      '',
      `# ${ent.label}`,
      '',
    ];
    for (const f of facts) {
      body.push(`## ${f.kind} — \`${f.key.slice(0, 120).replace(/`/g, "'")}\``);
      body.push(`_${f.support}× · confidence ${f.confidence}/100 · ~$${f.estUsdPerRun}/run to re-derive_`, '');
      body.push('```', f.value.slice(0, 600), '```', '');
    }
    const outRel = out.get(ent.id) ?? [];
    if (outRel.length) {
      body.push('## References', '');
      for (const r of outRel) {
        const l = link(r.to);
        if (l) body.push(`- ${r.rel === 'lists' ? 'enumerates' : 'mentions'} ${l}`);
      }
      body.push('');
    }
    const incRel = inc.get(ent.id) ?? [];
    if (incRel.length) {
      body.push('## Referenced by', '');
      for (const r of incRel) {
        const l = link(r.from);
        if (l) body.push(`- ${r.rel === 'lists' ? 'enumerated by' : 'mentioned by'} ${l}`);
      }
      body.push('');
    }
    files.push({ path: `knowledge/${p}`, content: `${body.join('\n')}\n` });
  }

  // index.md — the entry point telling the agent how to use the graph.
  const idx: string[] = [
    frontmatter({
      type: 'index',
      title: `${agentId} — known facts`,
      description: `Stable facts mined from ${runCount} runs — ${entries.length} facts across ${entities.length} concepts.`,
      tags: [`agent:${agentId}`],
      timestamp: opts.generatedAt,
    }),
    '',
    `# ${agentId} — knowledge`,
    '',
    `These are **stable facts** about this codebase, mined from the agent's last ${runCount} runs. Before exploring, **look up the concept you need below and read it instead of re-running the lookup** (grep / glob / file read / fetch). Concepts link to each other — follow the links to related files and symbols.`,
    '',
  ];
  const byType = new Map<string, KnowledgeNode[]>();
  for (const e of entities) (byType.get(e.entityType!) ?? byType.set(e.entityType!, []).get(e.entityType!)!).push(e);
  for (const [t, ns] of byType) {
    idx.push(`## ${t}`, '');
    for (const n of ns.sort((a, b) => b.degree - a.degree)) {
      idx.push(`- [${n.label}](${pathById.get(n.id)})${n.degree > 1 ? ` _(${n.degree} links)_` : ''}`);
    }
    idx.push('');
  }
  files.unshift({ path: 'knowledge/index.md', content: `${idx.join('\n')}\n` });
  return files;
}

/* ---- slim context -------------------------------------------------------
 * The SMALLEST set of facts worth carrying in an agent's context: the answers
 * to the lookups it repeats every run, highest-value first, capped at a token
 * budget, each answer compacted. The agent reads these and SKIPS the
 * greps/globs/reads that produce them. Nothing else is pushed — the long tail
 * (cheap to re-derive) stays out of context; big values point at the OKF file
 * instead of bloating the prompt. Universal: a plain string any agent can be
 * given as system context (not Claude-only, unlike a SKILL). */

export interface SlimContext {
  /** Ready-to-inject markdown. Empty when nothing clears the bar. */
  markdown: string;
  factsIncluded: number;
  factsTotal: number;
  /** Rough token estimate of `markdown` (chars ÷ 4). */
  estTokens: number;
  /** Per-run re-derivation cost the included facts remove. */
  estUsdPerRun: number;
}

export function renderSlimContext(
  report: KnowledgeGraphReport,
  opts: { tokenBudget?: number; maxValueChars?: number } = {},
): SlimContext {
  const budget = opts.tokenBudget ?? 1200;
  const maxVal = opts.maxValueChars ?? 200;
  const estTokens = (s: string) => Math.ceil(s.length / 4);

  const compactKey = (e: KnowledgeEntry): string => {
    let arg = e.key;
    try {
      const o = JSON.parse(e.key) as Record<string, unknown>;
      const vals = Object.values(o).filter((x): x is string => typeof x === 'string');
      if (vals.length) arg = vals.join(' ');
    } catch {
      /* raw */
    }
    return `${e.tool} ${arg}`.replace(/\s+/g, ' ').trim().slice(0, 120);
  };
  const compactVal = (v: string): string => {
    const one = v.replace(/\s*\n\s*/g, ' · ').replace(/\s+/g, ' ').trim();
    return one.length > maxVal ? `${one.slice(0, maxVal)}… (full content known — do not re-read)` : one;
  };

  const ranked = [...report.entries].sort(
    (a, b) => b.support * b.estUsdPerRun - a.support * a.estUsdPerRun || b.confidence - a.confidence,
  );
  const header = `## Already known — do NOT re-run these lookups (stable across ${report.runCount} runs)`;
  const lines: string[] = [];
  let tokens = estTokens(header);
  let usd = 0;
  for (const e of ranked) {
    const line = `- \`${compactKey(e)}\` → ${compactVal(e.value)}`;
    const t = estTokens(line);
    if (tokens + t > budget) continue; // too big for what's left — keep scanning for smaller high-value facts
    lines.push(line);
    tokens += t;
    usd += e.estUsdPerRun;
  }
  return {
    markdown: lines.length ? `${header}\n\n${lines.join('\n')}\n` : '',
    factsIncluded: lines.length,
    factsTotal: report.entries.length,
    estTokens: tokens,
    estUsdPerRun: Math.round(usd * 10000) / 10000,
  };
}
