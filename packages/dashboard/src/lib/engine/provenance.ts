// VENDORED from packages/core|server (dashboard can't take workspace deps on Vercel).
/**
 * Slot provenance — determinism v3, level D1 (docs/determinism-v3.md).
 *
 * templateInfo can say "this step's input is a fixed skeleton with volatile
 * slots" — provenance answers the question that makes it *executable*: WHERE
 * does each slot's value come from? For every run we search the step's
 * upstream outputs (the dataflow the graph already witnesses) and the task
 * prompt. A slot that the same (source column, extraction method) explains in
 * ≥90% of runs is mechanically DERIVABLE — code can compute the argument, no
 * LLM needed. Slots explained only by the prompt are caller parameters. The
 * rest stay unresolved (the step is a parameterized tool at best).
 */

import type { AlignedColumn } from './align.ts';

export interface SlotTrace {
  slot: number;
  kind: 'derived' | 'param' | 'unresolved';
  /** Medoid column index of the source step (kind === 'derived'). */
  sourceColumn?: number;
  /** Extraction on the source output: 'json:<path>' | 'line:<n>' | 'substr'. */
  method?: string;
  /** Share of traceable runs explained by the winning (source, method). */
  share: number;
  examples: string[];
}

const MIN_SLOT_LEN = 3; // values shorter than this can't be traced reliably
const LOOKBACK = 15; // columns searched upstream (dataflow is local in practice)
const MIN_SHARE = 0.9; // agreement required to call a slot derived/param

/** Depth-limited search for a JSON path whose value stringifies to `target`. */
function findJsonPath(value: unknown, target: string, depth = 0): string | null {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value !== 'object') {
    return String(value) === target ? '' : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, 50); i++) {
      const p = findJsonPath(value[i], target, depth + 1);
      if (p !== null) return p === '' ? String(i) : `${i}.${p}`;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = findJsonPath(v, target, depth + 1);
    if (p !== null) return p === '' ? k : `${k}.${p}`;
  }
  return null;
}

/** Re-run an extraction method against a raw output (replay validation). */
export function extractByMethod(raw: string, method: string): string | null {
  if (method.startsWith('json:')) {
    try {
      let v: unknown = JSON.parse(raw);
      const path = method.slice(5);
      if (path !== '') {
        for (const part of path.split('.')) {
          if (v === null || typeof v !== 'object') return null;
          v = (v as Record<string, unknown>)[part];
        }
      }
      if (v === null || v === undefined || typeof v === 'object') return null;
      return String(v);
    } catch {
      return null;
    }
  }
  if (method.startsWith('line:')) {
    const k = Number(method.slice(5));
    const line = raw.split('\n')[k];
    return line === undefined ? null : line.trim();
  }
  return null; // 'substr' verifies presence only; it cannot reconstruct
}

export interface TraceSlotsArgs {
  columns: AlignedColumn[];
  /** Column whose input slots we are tracing (medoid index). */
  colIndex: number;
  /** Per run: the column's volatile-token values, or null (gap / non-modal shape). */
  slotValues: (string[] | null)[];
  /** Per run: the task prompt (param detection). */
  prompts: (string | undefined)[];
}

/**
 * Trace every slot of a templated column. Per run, the NEAREST upstream output
 * containing the value wins (a consistent nearest source across runs is the
 * strongest provenance signal); the method is the most specific extraction
 * that reproduces it (json > line > substr).
 */
export function traceSlots(args: TraceSlotsArgs): SlotTrace[] {
  const { columns, colIndex, slotValues, prompts } = args;
  const slotCount = slotValues.find((v) => v !== null)?.length ?? 0;
  const traces: SlotTrace[] = [];
  const jsonCache = new Map<string, unknown>(); // `${col}|${run}` → parsed raw (or null)

  for (let s = 0; s < slotCount; s++) {
    const votes = new Map<string, { count: number; sourceColumn: number; method: string }>();
    let paramVotes = 0;
    let total = 0;
    const examples: string[] = [];

    for (let ri = 0; ri < slotValues.length; ri++) {
      const vals = slotValues[ri];
      if (!vals) continue;
      const v = vals[s];
      total++;
      if (examples.length < 3 && !examples.includes(v)) examples.push(v.slice(0, 80));
      if (v.length < MIN_SLOT_LEN) continue; // too short to trace — no vote

      let voted = false;
      for (let j = colIndex - 1; j >= Math.max(0, colIndex - LOOKBACK); j--) {
        const node = columns[j]?.nodes[ri];
        if (!node) continue;
        if (node.kind !== 'tool_result' && node.kind !== 'model_turn') continue;
        if (!node.raw.includes(v)) continue;

        let method = 'substr';
        const cacheKey = `${j}|${ri}`;
        if (!jsonCache.has(cacheKey)) {
          try {
            jsonCache.set(cacheKey, JSON.parse(node.raw));
          } catch {
            jsonCache.set(cacheKey, null);
          }
        }
        const parsed = jsonCache.get(cacheKey);
        if (parsed !== null && parsed !== undefined) {
          const path = findJsonPath(parsed, v);
          // Paths with whitespace can't survive tokenized templates — skip them.
          if (path !== null && !/\s/.test(path)) method = `json:${path}`;
        }
        if (method === 'substr') {
          const lineIdx = node.raw.split('\n').findIndex((l) => l.trim() === v);
          if (lineIdx >= 0) method = `line:${lineIdx}`;
        }

        const key = `${j}|${method}`;
        const prev = votes.get(key);
        if (prev) prev.count++;
        else votes.set(key, { count: 1, sourceColumn: j, method });
        voted = true;
        break; // nearest source only
      }
      if (!voted && prompts[ri]?.includes(v)) paramVotes++;
    }

    let winner: { count: number; sourceColumn: number; method: string } | undefined;
    for (const cand of votes.values()) {
      if (!winner || cand.count > winner.count) winner = cand;
    }

    if (total > 0 && winner && winner.count / total >= MIN_SHARE) {
      traces.push({
        slot: s,
        kind: 'derived',
        sourceColumn: winner.sourceColumn,
        method: winner.method,
        share: winner.count / total,
        examples,
      });
    } else if (total > 0 && paramVotes / total >= MIN_SHARE) {
      traces.push({ slot: s, kind: 'param', share: paramVotes / total, examples });
    } else {
      traces.push({
        slot: s,
        kind: 'unresolved',
        share: total === 0 ? 0 : Math.max(winner?.count ?? 0, paramVotes) / total,
        examples,
      });
    }
  }
  return traces;
}
