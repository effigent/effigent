// Renders the NEW OUTPUT page from the engine (analyzeAgent + rent series + skyline) over local transcripts.
import fs from 'node:fs'; import path from 'node:path';
import { parseTranscript, analyzeAgent, computeRentLedger, simulateCompaction, REACQUISITION_SCENARIOS, contextSkylineSvg, SKYLINE_LAYERS } from '../../packages/core/dist/index.js';
const root = process.env.HOME + '/.claude/projects'; const WINDOW = 40; const outFile = process.argv[2];
const byAgent = {};
for (const d of fs.readdirSync(root)) { const dir = path.join(root, d); if (!fs.statSync(dir).isDirectory()) continue;
  const agent = d.replace(/^-(Users|home)-[^-]+-?/, '').replace(/^(Documents-private-|Documents-|Projects-)/, '') || 'home';
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) { const r = parseTranscript(fs.readFileSync(path.join(dir, f), 'utf8'), { agentId: agent }); if (r) (byAgent[agent] ??= []).push(r); } }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const $ = (v) => '$' + (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
const agents = [];
for (const [agent, runs] of Object.entries(byAgent)) { if (runs.length < 3) continue;
  runs.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')); const w = runs.slice(0, WINDOW);
  const a = analyzeAgent(agent, w);
  const top = [...w].sort((x, y) => y.costUsd - x.costUsd)[0];
  const L = computeRentLedger(top, { series: true }); const T = a.compaction.threshold ?? 400_000;
  const trace = []; const sim = L.peakContext > T ? simulateCompaction(top, T, REACQUISITION_SCENARIOS[1], trace) : null;
  a.top = { cost: top.costUsd, requests: L.requests, peak: L.peakContext, reads: L.spend.cacheReadUsd, started: top.startedAt, svg: contextSkylineSvg(L.series, sim ? { counterfactual: trace, threshold: T, width: 900, height: 260 } : { width: 900, height: 260 }), simSaved: sim ? top.costUsd - sim.costUsd : null, T };
  agents.push(a); }
agents.sort((a, b) => b.costUsd - a.costUsd);
const tot = { cost: 0, read: 0, write: 0, side: 0, gen: 0, runs: 0 };
for (const a of agents) { tot.cost += a.costUsd; tot.runs += a.runs; tot.read += a.spend.cacheReadUsd; tot.write += a.spend.cacheWriteUsd + a.spend.uncachedUsd; tot.side += a.spend.sideModelUsd; tot.gen += a.spend.outputUsd + a.spend.thinkingUsd; }
const sumPlan = (id) => agents.reduce((acc, a) => { const p = a.plan.find((x) => x.id === id); if (p?.savingsUsd) { acc.lo += p.savingsUsd.low; acc.hi += p.savingsUsd.high; } return acc; }, { lo: 0, hi: 0 });
const spillSum = sumPlan('spill-exploration'), compSum = sumPlan('compact-earlier');
const pct = (v) => (100 * v / tot.cost).toFixed(0);
const burstShare = (100 * agents.reduce((x, a) => x + a.spill.burstRequests, 0) / Math.max(1, agents.reduce((x, a) => x + a.spill.requests, 0))).toFixed(0);
const bar = (s, total) => { const parts = [['read', 'Re-reading context', s.read], ['write', 'Writing context', s.write], ['side', 'Advisor / side model', s.side], ['gen', 'Generating (output + thinking)', s.gen]];
  const sum = parts.reduce((x, p) => x + p[2], 0) || 1;
  return `<div class="bar" role="img" aria-label="Spend split">${parts.map(([k, l, v]) => `<span class="seg seg-${k}" style="width:${(100 * v / sum).toFixed(2)}%" title="${l}: ${$(v)}"></span>`).join('')}</div>
  <ul class="legend">${parts.map(([k, l, v]) => `<li><i class="sw seg-${k}"></i>${l} <b>${(100 * v / sum).toFixed(0)}%</b> <span class="mut">${$(v)}</span></li>`).join('')}</ul>`; };
const BASIS = { measured: ['measured', 'Identity over observed spend'], simulated: ['simulated', 'Trace-replay, calibrated against observed cost'], structural: ['if adopted', 'Holds if the agent follows the change; confirm with a before/after window'], 'needs-ab': ['needs A/B', 'Real mechanism; size only learnable live'] };
const planHtml = (a) => a.plan.length ? a.plan.map((p) => `<article class="item">
  <header><span class="basis b-${p.basis}" title="${esc(BASIS[p.basis][1])}">${BASIS[p.basis][0]}</span><h4>${esc(p.title)}</h4>${p.savingsUsd ? `<span class="save">${$(p.savingsUsd.low)}–${$(p.savingsUsd.high)}</span>` : ''}</header>
  <p>${esc(p.evidence)}</p>
  ${p.files.map((f) => `<details><summary><code>${esc(f.path)}</code><span class="mut"> · ${esc(f.note ?? '')}</span></summary><pre>${esc(f.content)}</pre></details>`).join('')}
</article>`).join('') : '<p class="mut">Nothing cleared the evidence gates for this agent.</p>';
const agentHtml = agents.map((a) => `<section class="agent" id="${esc(a.agentId)}">
  <div class="agent-head"><h2>${esc(a.agentId)}</h2><div class="facts"><span><b>${$(a.costUsd)}</b> over ${a.runs} sessions</span><span>rent identity <b>${a.calibration.toFixed(3)}</b></span>${a.instructionsTokens > 1000 ? `<span>CLAUDE.md <b>${Math.round(a.instructionsTokens / 1000)}k</b> tokens</span>` : ''}<span>${a.coldRewrites.count} cache expiries <b>${$(a.coldRewrites.penaltyUsd)}</b></span></div></div>
  ${bar({ read: a.spend.cacheReadUsd, write: a.spend.cacheWriteUsd + a.spend.uncachedUsd, side: a.spend.sideModelUsd, gen: a.spend.outputUsd + a.spend.thinkingUsd })}
  <figure class="sky"><figcaption>Most expensive session · ${$(a.top.cost)} · ${a.top.requests} requests · peak ${Math.round(a.top.peak / 1000)}k tokens · re-reading ${$(a.top.reads)}${a.top.simSaved != null ? ` · dashed line: the same session compacting at ${a.top.T / 1000}k, ${a.top.simSaved >= 0 ? 'saves' : 'costs'} ${$(Math.abs(a.top.simSaved))}` : ''}</figcaption><div class="svgwrap">${a.top.svg}</div></figure>
  <h3>Compiled plan</h3>
  ${planHtml(a)}
</section>`).join('\n');
const layers = SKYLINE_LAYERS.map((l) => `<li><i class="sw" style="background:${l.color}"></i>${esc(l.label)}</li>`).join('');
const html = `<title>Context Rent Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{--bg:#f5f6f8;--surface:#ffffff;--ink:#15171c;--mut:#5a6170;--line:#dde0e6;--acc:#3d5afe;--read:#7c5cff;--write:#0b84ff;--side:#e09a1f;--gen:#00a37a;--ok:#0a8f6a;--warn:#c4661f;--code:#eef0f4;
--display:"Archivo",system-ui,sans-serif;--body:"IBM Plex Sans",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#0e1014;--surface:#161920;--ink:#e6e8ee;--mut:#9aa1b0;--line:#2a2f3a;--acc:#8c9eff;--code:#1d2129;--ok:#35c79a;--warn:#f0a15c}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#0e1014;--surface:#161920;--ink:#e6e8ee;--mut:#9aa1b0;--line:#2a2f3a;--acc:#8c9eff;--code:#1d2129;--ok:#35c79a;--warn:#f0a15c}
body{background:var(--bg);color:var(--ink);font:15px/1.55 var(--body);padding-inline:16px;padding-block:28px 64px}
.wrap{max-width:980px;margin:0 auto;display:flex;flex-direction:column;gap:36px}
h1,h2,h3,h4{font-family:var(--display);text-wrap:balance;margin:0}
h1{font-size:clamp(28px,4.6vw,42px);font-weight:800;letter-spacing:-.01em;line-height:1.1}
h2{font-size:24px;font-weight:700}h3{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);font-weight:700;margin-top:4px}h4{font-size:15.5px;font-weight:700}
p{margin:0;max-width:68ch}.mut{color:var(--mut)}b{font-variant-numeric:tabular-nums}
.eyebrow{font:500 12px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--acc)}
.lede{font-size:17px;color:var(--mut);max-width:64ch}
.intro{display:flex;flex-direction:column;gap:14px}
.bar{display:flex;height:16px;border-radius:3px;overflow:hidden;background:var(--line)}
.seg-read{background:var(--read)}.seg-write{background:var(--write)}.seg-side{background:var(--side)}.seg-gen{background:var(--gen)}
.legend{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.tested{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.test{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:12px 14px;display:flex;flex-direction:column;gap:6px}
.test .v{font:600 12px var(--mono);letter-spacing:.04em;text-transform:uppercase}.v-yes{color:var(--ok)}.v-no{color:var(--warn)}
.test h4{font-size:14.5px}.test p{font-size:13.5px;color:var(--mut)}
.agent{display:flex;flex-direction:column;gap:14px;padding-top:26px;border-top:1px solid var(--line)}
.agent-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 20px}
.facts{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:13.5px;color:var(--mut)}.facts b{color:var(--ink)}
figure{margin:0}.sky figcaption{font-size:13px;color:var(--mut);margin-bottom:6px}
.svgwrap{overflow-x:auto;color:var(--mut);background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:8px}
.svgwrap svg{min-width:560px;display:block}
.item{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.item header{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 10px}.item p{font-size:14px;color:var(--mut)}
.save{margin-left:auto;font:600 14px var(--mono);font-variant-numeric:tabular-nums}
.basis{font:500 11px var(--mono);text-transform:uppercase;letter-spacing:.05em;padding:1px 6px;border-radius:3px;border:1px solid currentColor}
.b-measured{color:var(--ok)}.b-simulated{color:var(--acc)}.b-structural{color:var(--warn)}.b-needs-ab{color:var(--mut)}
details summary{cursor:pointer;font-size:13.5px}details summary:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
code{font-family:var(--mono);font-size:.92em}
pre{font:12.5px/1.5 var(--mono);background:var(--code);border-radius:4px;padding:10px 12px;margin:8px 0 0;overflow-x:auto;white-space:pre}
.layers{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12.5px;color:var(--mut)}
nav.toc{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13.5px}nav.toc a{color:var(--acc);text-decoration:none}nav.toc a:hover{text-decoration:underline}
</style>
<div class="wrap">
  <header class="intro">
    <div class="eyebrow">Effigent · engine output on ${tot.runs} local Claude Code sessions · ${agents.length} agents</div>
    <h1>The money is in what the agent carries, not in what it decides.</h1>
    <p class="lede">Every request re-reads the whole context window. Across these agents, ${(100 * tot.gen / tot.cost).toFixed(0)}% of ${$(tot.cost)} paid for the model producing anything; the rest paid for carrying and re-reading context and for uncached advisor calls. So the compiler's job moves from replacing decisions to controlling context.</p>
    ${bar(tot, tot.cost)}
  </header>

  <section class="intro">
    <h3>What was tested on this data</h3>
    <div class="tested">
      <div class="test"><span class="v v-no">≈2% · not the lever</span><h4>Predict the next decision</h4><p>Trained on each agent's past sessions, scored on later ones: 2.6% of decisions predictable at ≥80% confidence, 0% once arguments count.</p></div>
      <div class="test"><span class="v v-no">≈2% · not the lever</span><h4>Re-written programs</h4><p>Near-duplicate code the model regenerates: 1.9% of future scripts matched an earlier one (0.3% of generated code).</p></div>
      <div class="test"><span class="v v-no">loses live data</span><h4>Trim tool output by rules</h4><p>Head/tail/error filters drop 13% of shell output but also 13% of the lines the model later used.</p></div>
      <div class="test"><span class="v v-yes">exact · 1.00</span><h4>Context rent</h4><p>Everything in context pays tokens × read price on each later request. This reproduces observed re-reading spend to within 1%.</p></div>
      <div class="test"><span class="v v-yes">${pct(spillSum.lo)}–${pct(spillSum.hi)}% if adopted</span><h4>Explore in a subagent</h4><p>${burstShare}% of requests are runs of read-only lookups made from a huge main context (${$(spillSum.lo)}–${$(spillSum.hi)}). From a small isolated context the same lookups are cheap.</p></div>
      <div class="test"><span class="v v-yes">${pct(compSum.lo)}–${pct(compSum.hi)}% simulated</span><h4>Compact earlier</h4><p>Replaying every session under "compact at 400k" instead of ~1M saves ${$(compSum.lo)}–${$(compSum.hi)} in every re-exploration scenario measured. Not additive with the subagent change.</p></div>
    </div>
  </section>

  <section class="intro">
    <h3>Reading the skylines</h3>
    <p class="mut">Each chart is one session: context size per request, stacked by what the context holds. The area under the curve, times the read price, is that session's re-reading bill. Cliffs are compactions.</p>
    <ul class="layers">${layers}<li><i class="sw" style="background:transparent;border:1px dashed currentColor"></i>same session under the compaction policy</li></ul>
    <nav class="toc">${agents.map((a) => `<a href="#${esc(a.agentId)}">${esc(a.agentId)} · ${$(a.costUsd)}</a>`).join('')}</nav>
  </section>

  ${agentHtml}

  <p class="mut" style="font-size:13px">Numbers are over each agent's last ${WINDOW} sessions, priced with the corrected table (checked against Claude Code's own totals: median ratio 0.999). Plan items marked "if adopted" hold only if the agent follows the change; compare a window before and after. Method and every experiment: docs/context-rent.md.</p>
</div>`;
fs.writeFileSync(outFile, html); console.log('wrote', outFile, (html.length / 1024).toFixed(0) + 'KB', agents.map((a) => a.agentId).join(','));
