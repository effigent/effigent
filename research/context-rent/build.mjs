// Research dataset: one record per session with a per-REQUEST trace + asks + harness events.
import fs from 'node:fs'; import path from 'node:path';
import { actionToken, usageCostUsd } from '../../packages/core/dist/index.js';
const root = process.env.HOME + '/.claude/projects';
const out = [];
const HUMAN = (o) => !o.isCompactSummary && (!o.origin?.kind || o.origin.kind === 'human') && o.promptSource !== 'system';
const META = /^\s*<(command-|local-command|system-reminder|task-notification|bash-|user-memory)|^\s*Caveat:/;
for (const d of fs.readdirSync(root)) { const dir = path.join(root, d); if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const L = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const reqs = new Map(); const order = []; const asks = []; const ev = []; let aiTitle = null; const toolById = new Map();
    for (const o of L) {
      if (o.type === 'ai-title') aiTitle = o.aiTitle;
      if (o.type === 'pr-link') ev.push({ t: 'pr', ts: o.timestamp, url: o.prUrl });
      if (o.subtype === 'compact_boundary') ev.push({ t: 'compact', ts: o.timestamp, pre: o.compactMetadata?.preTokens, post: o.compactMetadata?.postTokens, trigger: o.compactMetadata?.trigger });
      if (o.subtype === 'away_summary') ev.push({ t: 'recap', ts: o.timestamp, text: o.content });
      if (o.subtype === 'turn_duration') ev.push({ t: 'turn', ts: o.timestamp, ms: o.durationMs });
      if (o.isSidechain) continue;
      if (o.type === 'user' && o.message) {
        const c = o.message.content;
        if (o.toolDenialKind) ev.push({ t: 'deny', ts: o.timestamp, kind: o.toolDenialKind });
        if (o.toolUseResult?.gitOperation) ev.push({ t: 'git', ts: o.timestamp, op: o.toolUseResult.gitOperation });
        const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text) : [];
        for (const t of texts) if (t?.trim() && HUMAN(o) && !META.test(t)) asks.push({ ts: o.timestamp, text: t, reqIdx: order.length, interrupt: /\[Request interrupted/.test(t) });
        if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') { const tu = toolById.get(b.tool_use_id); if (tu) { tu.err = b.is_error === true; const txt = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => x.text ?? '').join('') : ''; tu.resLen = txt.length; tu.res = txt.slice(0, 2000); } }
      }
      if (o.type === 'assistant' && o.message?.usage && o.message.model !== '<synthetic>') {
        const k = o.requestId ?? o.uuid; let r = reqs.get(k);
        if (!r) { const u = o.message.usage; const usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheCreationInputTokens: u.cache_creation_input_tokens, cacheCreation1hInputTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0, cacheReadInputTokens: u.cache_read_input_tokens };
          const msgIters = (u.iterations ?? []).filter((it) => it.type === 'message');
          const lastIt = msgIters[msgIters.length - 1];
          const ctx = lastIt ? lastIt.input_tokens + (lastIt.cache_creation_input_tokens ?? 0) + (lastIt.cache_read_input_tokens ?? 0) : u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
          r = { ctx, iters: msgIters.length || 1, ts: o.timestamp, model: o.message.model, in: u.input_tokens, cw: u.cache_creation_input_tokens, cw1h: usage.cacheCreation1hInputTokens, cr: u.cache_read_input_tokens, out: u.output_tokens, think: u.output_tokens_details?.thinking_tokens ?? 0, cost: usageCostUsd(o.message.model, usage), effort: o.effort, tools: [], text: 0, stop: o.message.stop_reason };
          for (const it of u.iterations ?? []) if (it.type === 'advisor_message') r.cost += usageCostUsd(it.model, { inputTokens: it.input_tokens, outputTokens: it.output_tokens, cacheCreationInputTokens: it.cache_creation_input_tokens ?? 0, cacheReadInputTokens: it.cache_read_input_tokens ?? 0 });
          reqs.set(k, r); order.push(r); }
        for (const b of o.message.content ?? []) {
          if (b.type === 'text') r.text += (b.text ?? '').length;
          if (b.type === 'tool_use') { const tu = { name: b.name, action: actionToken({ kind: 'tool_use', name: b.name, payload: JSON.stringify(b.input ?? {}) }), input: JSON.stringify(b.input ?? {}).slice(0, 600), full: (b.name === 'Bash' ? String(b.input?.command ?? '') : b.name === 'Write' ? String(b.input?.content ?? '') : b.name === 'Edit' ? String(b.input?.new_string ?? '') : '').slice(0, 20000), fp: b.input?.file_path, desc: b.input?.description }; r.tools.push(tu); toolById.set(b.id, tu); }
        }
      }
    }
    if (!order.length) continue;
    out.push({ project: d.replace(/^-(Users|home)-[^-]+-?/, '').replace(/^(Documents-private-|Documents-|Projects-)/, '') || 'home', sid: f.replace('.jsonl', ''), start: order[0].ts, aiTitle, reqs: order, asks, ev, hasSub: fs.existsSync(path.join(dir, f.replace('.jsonl', ''), 'subagents')) });
  } }
out.sort((a, b) => a.start.localeCompare(b.start));
fs.writeFileSync(process.argv[2], JSON.stringify(out));
console.log('sessions', out.length, 'requests', out.reduce((s, x) => s + x.reqs.length, 0), 'asks', out.reduce((s, x) => s + x.asks.length, 0), 'cost $', out.reduce((s, x) => s + x.reqs.reduce((a, r) => a + r.cost, 0), 0).toFixed(0), 'span', out[0].start, '→', out[out.length - 1].start);
const byP = {}; for (const s of out) { const p = byP[s.project] ??= { n: 0, cost: 0 }; p.n++; p.cost += s.reqs.reduce((a, r) => a + r.cost, 0); } console.table(byP);
