/**
 * `effigent recommendations` / `effigent applied` — the plan in the form a coding
 * agent applies it, and the record of when it did. The server computes the plan
 * (GET /api/v1/recommendations, same analysis as Insights); this module only
 * renders it. The rules below are the short form of docs/applying-recommendations.md.
 */

export interface RecFile { path: string; note?: string; content: string }
export interface Recommendation {
  id: string;
  title: string;
  why: string;
  basis: string;
  perMonthUsd: { low: number; high: number } | null;
  files: RecFile[];
  appliedAt: string | null;
  source: 'marked' | 'detected' | null;
}
export interface RecommendationsResponse {
  agent: string;
  sessions: number;
  headline?: string;
  recommendations: Recommendation[];
  notes: { id: string; title: string; why: string }[];
  note?: string;
}

const RULES = [
  'Run `git status` first. Never commit, stash or reformat work that is not yours; only add files and append lines.',
  'Read every file before changing it; never overwrite one. Merge JSON settings (keep every other key); add CLAUDE.md lines where they will be read, in the file\'s own voice.',
  'A generated file is a template: fill placeholders from the project\'s own docs and the commands it really runs. Where the right command depends on what changed (per-surface deploys), write the routing, not one command.',
  'In a repo other people share, put personal behaviour settings (compaction window, models) in `.claude/settings.local.json`. Leave committing to the user.',
  'Items marked "needs-ab" (e.g. restructuring CLAUDE.md) change what every session starts with: propose them to the user, do not apply them unasked.',
  'Writing a ship/deploy skill is not a reason to deploy. Write files only.',
  'Record a change only after it is written, with the `effigent applied` line under it.',
];

const money = (v: number) => (v >= 100 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toFixed(v >= 10 ? 0 : 2)}`);
const fence = (content: string) => (content.includes('```') ? '~~~~' : '```');

export function renderForAgent(r: RecommendationsResponse): string {
  const out: string[] = [];
  out.push(`# Effigent recommendations — ${r.agent} (${r.sessions} sessions analysed)`);
  if (r.note) out.push('', r.note);
  if (r.headline) out.push('', r.headline);
  const open = r.recommendations.filter((x) => !x.appliedAt);
  const done = r.recommendations.filter((x) => x.appliedAt);
  if (open.length) {
    out.push('', '## How to apply', '', ...RULES.map((s, i) => `${i + 1}. ${s}`));
    out.push('', '## Open');
    open.forEach((x, i) => {
      const value = x.perMonthUsd ? ` · ≈${money(x.perMonthUsd.low)}–${money(x.perMonthUsd.high)}/month` : '';
      out.push('', `### ${i + 1}. ${x.title}`, `id \`${x.id}\` · ${x.basis}${value}`, '', x.why);
      if (x.basis === 'needs-ab') out.push('', 'Needs an A/B: propose it to the user and apply it only when asked, on its own (not in the same week as another change).');
      else if (!x.files.length) out.push('', 'No file: a habit or a setting for the person — report it, do not invent a file.');
      for (const f of x.files) {
        const f3 = fence(f.content);
        out.push('', `File \`${f.path}\`${f.note ? ` — ${f.note}` : ''}`, f3, f.content.replace(/\n$/, ''), f3);
      }
      out.push('', `When done: \`effigent applied ${x.id} --agent ${r.agent}\``);
    });
  } else if (r.recommendations.length) {
    out.push('', 'Nothing open — every recommendation is applied.');
  } else {
    out.push('', 'No recommendations yet.');
  }
  if (done.length) {
    out.push('', '## Already applied (being measured)');
    for (const x of done) out.push(`- ${x.title} (\`${x.id}\`) — applied ${x.appliedAt!.slice(0, 10)}${x.source === 'detected' ? ' (detected from sessions)' : ''}`);
  }
  if (r.notes.length) {
    out.push('', '## For the person (no file to write)');
    for (const n of r.notes) out.push(`- ${n.title} — ${n.why}`);
  }
  out.push('', 'Results: dashboard → Insights → Suggestions & results (needs ≥3 sessions after each change).');
  return out.join('\n') + '\n';
}

/** A user-level Claude Code skill: `/effigent-apply` in any repo applies that repo's plan. */
export function applySkill(bin: string): string {
  return `---
name: effigent-apply
description: Apply the changes Effigent measured for this project (subagents, compaction, skills) and record when they went in.
disable-model-invocation: true
---

Effigent's current plan for this project (fetched when the skill loaded):

!\`${bin} recommendations\`

Apply the **Open** recommendations above, following "How to apply" exactly. Record each
change you actually wrote with the \`effigent applied\` line under it — never one you skipped.
Finish with a short report: applied ids and files, what you left out and why, and anything
listed "For the person".
`;
}

/** `--at` → ISO timestamp; a bare date means the start of that day (UTC). */
export function parseAppliedAt(at: string | undefined, now = new Date()): string | null {
  if (!at) return now.toISOString();
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T00:00:00Z` : at);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
