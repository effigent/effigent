// E10 — what the HARNESS puts into context (attachments / system reminders), by type: size, count,
// and rent (each injection is carried to the end of its segment). Uses raw transcripts.
import fs from 'node:fs'; import path from 'node:path';
import { pricingFor } from '../../packages/core/dist/index.js';
const root = process.env.HOME + '/.claude/projects';
const agg = {}; let sessions = 0;
for (const d of fs.readdirSync(root)) { const dir = path.join(root, d); if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const L = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    // request timeline to know how long an injection is carried
    const reqTs = []; const seen = new Set(); let model = 'claude-opus-5';
    for (const o of L) if (o.type === 'assistant' && o.message?.usage && !o.isSidechain && o.message.model !== '<synthetic>') { const k = o.requestId; if (seen.has(k)) continue; seen.add(k); reqTs.push({ ts: o.timestamp, ctx: o.message.usage.input_tokens + o.message.usage.cache_creation_input_tokens + o.message.usage.cache_read_input_tokens }); model = o.message.model; }
    if (!reqTs.length) continue; sessions++;
    const rp = pricingFor(model).inputPerM * (pricingFor(model).cacheReadMult ?? 0.1) / 1e6;
    // segment ends (compaction)
    const resets = []; for (let i = 1; i < reqTs.length; i++) if (reqTs[i].ctx < 0.6 * reqTs[i - 1].ctx) resets.push(reqTs[i].ts);
    for (const o of L) { if (o.type !== 'attachment' || o.isSidechain) continue; const a = o.attachment ?? {}; const t = a.type ?? '?';
      const chars = JSON.stringify(a).length; const tok = chars / 3.6;
      const after = reqTs.filter((r) => r.ts > o.timestamp); const endTs = resets.find((x) => x > o.timestamp); const carried = after.filter((r) => !endTs || r.ts < endTs).length;
      const x = agg[t] ??= { n: 0, tok: 0, rent: 0, sess: new Set(), sample: '' }; x.n++; x.tok += tok; x.rent += tok * carried * rp; x.sess.add(f); if (!x.sample) x.sample = JSON.stringify(a).slice(0, 160); } } }
const rows = Object.entries(agg).map(([t, x]) => ({ type: t, count: x.n, sessions: x.sess.size, avgTok: Math.round(x.tok / x.n), totalKTok: Math.round(x.tok / 1e3), rentUsd: +x.rent.toFixed(0) })).sort((a, b) => b.rentUsd - a.rentUsd);
console.log('sessions', sessions, ' total attachment rent $' + rows.reduce((a, r) => a + r.rentUsd, 0)); console.table(rows.slice(0, 22));
for (const t of ['total_tokens_reminder', 'skill_listing', 'mcp_instructions_delta', 'agent_listing_delta', 'nested_memory', 'bash_output_audience_note', 'batching_reminder_sent', 'auto_mode', 'environment']) console.log(t, '→', agg[t]?.sample);
