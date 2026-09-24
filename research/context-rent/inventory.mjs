// Data inventory: for every signal in the raw transcripts, how many sessions carry it and how often,
// and whether the parser (→ Run → prod blob) keeps it.
import fs from 'node:fs'; import path from 'node:path';
const root = process.env.HOME + '/.claude/projects';
const S = {}; let sessions = 0; let subFiles = 0, subBytes = 0;
const hit = (k, sid, n = 1) => { const x = S[k] ??= { n: 0, sess: new Set() }; x.n += n; x.sess.add(sid); };
for (const d of fs.readdirSync(root)) { const dir = path.join(root, d); if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { const sd = path.join(p, 'subagents'); if (fs.existsSync(sd)) for (const x of fs.readdirSync(sd)) { subFiles++; subBytes += fs.statSync(path.join(sd, x)).size; } continue; }
    if (!f.endsWith('.jsonl')) continue; sessions++; const sid = f;
    for (const l of fs.readFileSync(p, 'utf8').split('\n')) { if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
      const t = o.type + (o.subtype ? ':' + o.subtype : '');
      if (['ai-title', 'pr-link', 'system:compact_boundary', 'system:turn_duration', 'system:away_summary', 'queue-operation', 'permission-mode', 'file-history-snapshot', 'system:model_refusal_fallback', 'system:stop_hook_summary'].includes(t)) hit(t, sid);
      if (o.toolDenialKind) hit('toolDenialKind:' + o.toolDenialKind, sid);
      if (o.isApiErrorMessage) hit('apiError', sid);
      const u = o.toolUseResult; if (u && typeof u === 'object') {
        if (u.gitOperation) hit('toolUseResult.gitOperation', sid);
        if (u.structuredPatch) hit('toolUseResult.structuredPatch (edit diff)', sid);
        if (u.returnCodeInterpretation) hit('toolUseResult.returnCodeInterpretation', sid);
        if (u.interrupted === true) hit('toolUseResult.interrupted', sid);
        if (u.userModified === true) hit('toolUseResult.userModified (user edited the change)', sid);
        if (u.durationMs != null) hit('toolUseResult.durationMs', sid);
        if (u.answers) hit('toolUseResult.answers (AskUserQuestion)', sid);
      }
      if (o.message?.stop_reason && o.message.stop_reason !== 'tool_use' && o.message.stop_reason !== 'end_turn') hit('stop_reason:' + o.message.stop_reason, sid);
      if (o.effort) hit('effort:' + o.effort, sid);
      if (o.type === 'user' && Array.isArray(o.message?.content)) for (const b of o.message.content) if (b.type === 'tool_result') { const txt = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join(''); if (txt.length > 20000) hit('tool_result > 20k chars (parser truncates)', sid); }
      if (o.type === 'assistant') for (const b of o.message?.content ?? []) if (b.type === 'thinking' && b.thinking?.length) hit('thinking text (not redacted)', sid);
    } } }
const KEPT = { 'ai-title': 'yes (title)', 'system:compact_boundary': 'inferred from context drop', 'toolUseResult.gitOperation': 'no', 'pr-link': 'no', 'system:turn_duration': 'no', 'toolUseResult.structuredPatch (edit diff)': 'no', 'toolUseResult.returnCodeInterpretation': 'no', 'system:away_summary': 'no', 'queue-operation': 'no', 'file-history-snapshot': 'no' };
const rows = Object.entries(S).map(([k, x]) => ({ signal: k, sessions: x.sess.size, share: (100 * x.sess.size / sessions).toFixed(0) + '%', occurrences: x.n, parserKeeps: KEPT[k] ?? (k.startsWith('effort') ? 'no' : k.startsWith('toolDenial') ? 'no' : k.startsWith('stop_reason') ? 'no' : 'no') })).sort((a, b) => b.sessions - a.sessions);
console.log(`${sessions} sessions · subagent transcripts: ${subFiles} files, ${(subBytes / 1e6).toFixed(1)} MB (CLI does not upload them)`); console.table(rows);
