import { getJson, putJson } from '@/lib/storage.ts';

/**
 * The recommendation record per agent — what Effigent suggested, when, what it
 * predicted, and when it was applied. Stored as one JSON document per agent in the
 * org's own bucket (no database migration; the org keeps its own history).
 */

export interface RecordedRecommendation {
  recId: string;
  title: string;
  basis: string;
  firstSuggestedAt: string;
  lastSuggestedAt: string;
  predictedPerMonthUsd: { low: number; high: number } | null;
  /** Parameters the measurement needs (e.g. the compaction threshold). */
  params?: { threshold?: number };
  appliedAt?: string;
  appliedBy?: string;
  /** 'marked' by a person, or 'detected' from the transcripts (loop.ts). */
  source?: 'marked' | 'detected';
}

export interface AgentRecord { agentId: string; recommendations: Record<string, RecordedRecommendation> }

const keyOf = (agentId: string) => `effigent/experiments/${agentId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200)}.json`;

export async function loadRecord(tenantId: string, agentId: string): Promise<AgentRecord> {
  return (await getJson<AgentRecord>(tenantId, keyOf(agentId))) ?? { agentId, recommendations: {} };
}

export async function saveRecord(tenantId: string, rec: AgentRecord): Promise<void> {
  await putJson(tenantId, keyOf(rec.agentId), rec);
}

/** Levers loop.ts can detect from transcripts, mapped to the recommendation they belong to. */
const DETECTED: Record<string, string> = { scout: 'spill-exploration', compaction: 'compact-earlier', instructions: 'shrink-instructions' };

/**
 * Upsert what the latest analysis suggested: new recommendations get their
 * first-suggested date, existing ones their latest prediction; adoption detected
 * from the transcripts is recorded unless a person already marked a date.
 * Returns true when the record changed.
 */
export function mergeSuggestions(
  rec: AgentRecord,
  actions: { id: string; title: string; basis: string; perMonthUsd: { low: number; high: number } | null }[],
  opts: { now: string; threshold?: number | null; detected?: { lever: string; adoptedAt: string }[] },
): boolean {
  let changed = false;
  for (const a of actions) {
    const cur = rec.recommendations[a.id];
    if (!cur) {
      rec.recommendations[a.id] = {
        recId: a.id, title: a.title, basis: a.basis, firstSuggestedAt: opts.now, lastSuggestedAt: opts.now,
        predictedPerMonthUsd: a.perMonthUsd, ...(a.id === 'compact-earlier' && opts.threshold ? { params: { threshold: opts.threshold } } : {}),
      };
      changed = true;
    } else {
      cur.lastSuggestedAt = opts.now;
      cur.title = a.title;
      cur.predictedPerMonthUsd = a.perMonthUsd;
      if (a.id === 'compact-earlier' && opts.threshold && !cur.appliedAt) cur.params = { threshold: opts.threshold };
      changed = true;
    }
  }
  // A detected change point before the suggestion is not the suggestion being applied —
  // it is the harness or the user changing on their own (measured: Claude Code began
  // auto-compacting some sessions near 500k and was read as "applied" 13 days before
  // Effigent suggested it). Those are marked by hand, if at all.
  for (const d of opts.detected ?? []) {
    const id = DETECTED[d.lever];
    const cur = id ? rec.recommendations[id] : undefined;
    if (cur && !cur.appliedAt && d.adoptedAt >= cur.firstSuggestedAt) { cur.appliedAt = d.adoptedAt; cur.source = 'detected'; changed = true; }
  }
  return changed;
}
