'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  SCHEMES, problems, engineParts, scoreBands, installTabs, INSTALL_CODE,
  originalStats, optimizedStats, buildRuntimeGraph, supportedHarnesses, type Scheme,
} from './data';
import { Nav, Footer } from './ui';
import { Reveal } from './reveal';
import { CountUp } from './countup';

const ACCENT = '#1a1d24';
const CONTENT = 1080;
const LINE = 'oklch(0.85 0.008 260)';
const RED = 'oklch(0.6 0.18 25)';

function FlowNode({ scheme, label, sub, mono, glow, minWidth = 118, delay = 0 }:
  { scheme: Scheme; label: string; sub?: string; mono?: boolean; glow?: boolean; minWidth?: number; delay?: number }) {
  return (
    <div style={{ opacity: 0, animation: 'fadeInUp .5s ease forwards', animationDelay: `${delay}s` }}>
      <div style={{ border: `1px solid ${scheme.border}`, background: scheme.bg, borderRadius: 9, padding: '11px 15px', textAlign: 'center', minWidth, animation: glow ? 'pulseGlow 2.2s ease-in-out infinite' : undefined }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: scheme.dot, flexShrink: 0 }} />
          <div style={{ fontSize: 13, fontWeight: 600, color: scheme.text, fontFamily: mono ? 'var(--mono)' : 'inherit', whiteSpace: 'nowrap' }}>{label}</div>
        </div>
        {sub && <div style={{ fontSize: 10, color: 'oklch(0.55 0.012 260)', marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

function Line({ h = 20, color = RED, delay = 0 }: { h?: number; color?: string; delay?: number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: 1, height: h, background: LINE, position: 'relative' }}>
        <div style={{ position: 'absolute', left: -2, top: 0, width: 5, height: 5, borderRadius: '50%', background: color, animation: 'flowDown 1.6s linear infinite', animationDelay: `${delay}s` }} />
      </div>
    </div>
  );
}
const Center = ({ children }: { children: ReactNode }) => <div style={{ display: 'flex', justifyContent: 'center' }}>{children}</div>;

function VGroup({ label, minWidth = 118 }: { label: string; minWidth?: number }) {
  return (
    <div style={{ border: `2px dashed ${RED}`, borderRadius: 12, padding: '10px 8px 2px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <FlowNode scheme={SCHEMES.blue} label="Search" minWidth={minWidth} />
        <Line h={16} /><FlowNode scheme={SCHEMES.purple} label="LLM Logic" minWidth={minWidth} />
        <Line h={16} /><FlowNode scheme={SCHEMES.blue} label="Search" minWidth={minWidth} />
      </div>
      <div style={{ textAlign: 'center', marginTop: 8, fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600, color: 'oklch(0.55 0.18 25)' }}>&rarr; {label}</div>
    </div>
  );
}

function Section({ id, children }: { id?: string; children: ReactNode }) {
  return <div id={id} style={{ maxWidth: CONTENT, margin: '0 auto', padding: '70px 32px', borderTop: '1px solid var(--line)' }}>{children}</div>;
}

function Eyebrow({ hue, children }: { hue: string; children: ReactNode }) {
  return <div className="eyebrow" style={{ color: `oklch(0.52 0.15 ${hue})` }}><span className="d" style={{ background: `oklch(0.58 0.17 ${hue})` }} />{children}</div>;
}

export default function Page() {
  const [tab, setTab] = useState('cli');
  const graph = buildRuntimeGraph();

  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      {/* NAV */}
      <Nav />

      {/* HERO */}
      <div style={{ position: 'relative', background: 'linear-gradient(180deg, oklch(0.95 0.018 275) 0%, oklch(0.97 0.012 275) 55%, oklch(0.985 0.004 90) 100%)', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(oklch(0.75 0.03 275 / 0.5) 1px, transparent 1px)', backgroundSize: '22px 22px', maskImage: 'radial-gradient(ellipse 70% 60% at 50% 20%, black 40%, transparent 100%)', WebkitMaskImage: 'radial-gradient(ellipse 70% 60% at 50% 20%, black 40%, transparent 100%)' }} />
        <div style={{ position: 'relative', maxWidth: CONTENT, margin: '0 auto', padding: '120px 32px 64px' }}>
          <div className="hero-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 460px', gap: 56, alignItems: 'center' }}>
            <div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 12.5, color: 'oklch(0.45 0.012 260)', border: '1px solid oklch(0.87 0.005 90)', borderRadius: 20, padding: '6px 14px', marginBottom: 26 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green-dot)' }} />Runtime layer for production AI agents
              </div>
              <div className="h-serif" style={{ fontSize: 52, lineHeight: 1.12, marginBottom: 22 }}>Stop paying your agents to think twice.</div>
              <div style={{ fontSize: 17, color: 'var(--ink-2)', lineHeight: 1.65, maxWidth: 520, marginBottom: 36 }}>
                Optimizer sits alongside every agent execution, watches which tool calls and reasoning steps never change, and replaces them with cache — no code changes, no new framework.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
                <Link href="/developers" className="btn btn-primary" style={{ padding: '13px 26px', fontSize: 14.5, display: 'inline-block' }}>Install in 2 minutes</Link>
                <Link href="/security" className="btn btn-ghost" style={{ padding: '13px 22px', fontSize: 14.5, display: 'inline-block' }}>Security &amp; privacy</Link>
              </div>
              <div style={{ maxWidth: 440, borderRadius: 9, background: 'oklch(0.14 0.01 260)', boxShadow: '0 16px 36px -18px oklch(0.14 0.01 260 / 0.5)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 12px', background: 'oklch(0.19 0.012 260)', borderBottom: '1px solid oklch(0.26 0.012 260)' }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'oklch(0.65 0.17 25)' }} />
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'oklch(0.78 0.15 85)' }} />
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'oklch(0.68 0.16 150)' }} />
                  <div style={{ margin: '0 auto', fontFamily: 'var(--mono)', fontSize: 11, color: 'oklch(0.55 0.012 260)', transform: 'translateX(-18px)' }}>zsh — optimizer install</div>
                </div>
                <div style={{ padding: '14px 16px', fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.9 }}>
                  <div style={{ color: 'oklch(0.85 0.01 150)' }}><span style={{ color: 'oklch(0.55 0.14 150)' }}>&#10142;</span> ccopt agent add billing-agent</div>
                  <div style={{ color: 'oklch(0.55 0.012 260)' }}>&gt; ✓ registered — scoped capture key saved</div>
                  <div style={{ color: 'oklch(0.85 0.01 150)' }}><span style={{ color: 'oklch(0.55 0.14 150)' }}>&#10142;</span> ccopt install claude --agent billing-agent</div>
                  <div style={{ color: 'oklch(0.55 0.012 260)', display: 'flex', alignItems: 'center', gap: 6 }}>&gt; ✓ every finished session now uploads<span style={{ display: 'inline-block', width: 7, height: 14, background: 'oklch(0.75 0.01 150)', animation: 'glowPulse 1s step-end infinite' }} /></div>
                </div>
              </div>
            </div>

            <div style={{ position: 'relative', border: '1px solid var(--line)', borderRadius: 14, background: 'oklch(0.995 0.002 90)', padding: 18, boxShadow: '0 20px 50px -24px oklch(0.2 0.012 260 / 0.25)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, padding: '0 4px' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Live call graph · acme-codegen-agent</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--green)' }}>
                  <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'oklch(0.6 0.16 150)', animation: 'glowPulse 1.6s ease-in-out infinite' }} />live
                </div>
              </div>
              <div style={{ position: 'relative', width: '100%', aspectRatio: '1', maxWidth: 400, margin: '0 auto' }}>
                {graph.edges.map((e, i) => (
                  <div key={i} style={{ position: 'absolute', left: '50%', top: '50%', width: '38%', height: 2, transformOrigin: '0 50%', transform: `rotate(${e.rot})` }}>
                    <div style={{ width: '100%', height: '100%', background: `linear-gradient(to right, oklch(0.85 0.01 260), ${e.heatColor})` }} />
                    <div style={{ position: 'absolute', top: '50%', left: 0, width: 5, height: 5, marginTop: -2.5, borderRadius: '50%', background: e.heatColor, animation: `flowOut ${e.flowDur} linear infinite`, animationDelay: e.flowDelay }} />
                  </div>
                ))}
                {graph.nodes.map((n, i) => (
                  <div key={i} style={{ position: 'absolute', left: n.left, top: n.top, transform: 'translate(-50%,-50%)' }}>
                    <div style={{ position: 'relative', padding: '7px 12px', borderRadius: 8, background: 'oklch(0.99 0.002 90)', border: `1px solid ${n.heatColor}`, fontSize: 11, fontWeight: 600, color: 'oklch(0.28 0.012 260)', whiteSpace: 'nowrap', animation: n.glow ? 'pulseGlow 2.4s ease-in-out infinite' : undefined }}>
                      {n.label}
                      <div style={{ position: 'absolute', top: -8, right: -8, minWidth: 17, height: 17, padding: '0 3px', borderRadius: 9, background: n.heatColor, color: 'white', fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)' }}>{n.count}</div>
                    </div>
                  </div>
                ))}
                <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 72, height: 72, borderRadius: '50%', background: ACCENT, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 6px oklch(0.2 0.012 260 / 0.06)', animation: 'pulseGlow 2.2s ease-in-out infinite' }}>
                  <div style={{ color: 'var(--cream)', fontSize: 10, fontWeight: 700, textAlign: 'center', lineHeight: 1.3, fontFamily: 'var(--mono)' }}>AGENT<br />RUNTIME</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, padding: '10px 12px', borderRadius: 8, background: 'oklch(0.97 0.005 260)', fontSize: 11, color: 'var(--ink-2)' }}>
                <div><span style={{ fontWeight: 700, color: 'oklch(0.55 0.15 20)' }}>3</span> hot paths detected</div>
                <div><span style={{ fontWeight: 700, color: 'oklch(0.4 0.13 150)' }}>$0.62</span> saved / 100 runs</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* WORKS WITH — marquee */}
      <div style={{ borderTop: '1px solid var(--line)', padding: '22px 0', background: 'oklch(0.975 0.004 90)' }}>
        <div className="marquee">
          <div className="marquee-track">
            {[0, 1].map((dup) => (
              <div key={dup} style={{ display: 'flex', gap: 56 }} aria-hidden={dup === 1}>
                {['Claude Code', 'OpenAI Codex', 'LangGraph', 'CrewAI', 'AutoGen', 'OpenAI Agents SDK', 'n8n', 'MCP agents', 'OpenTelemetry'].map((h) => (
                  <span key={h} className="marquee-item"><span className="mdot" />{h}</span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* IMPACT STATS */}
      <div style={{ borderTop: '1px solid var(--line)' }}>
        <div className="stats-band" style={{ maxWidth: CONTENT, margin: '0 auto', padding: '54px 32px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24 }}>
          {([
            [81, '%', 'fewer steps per run'],
            [76, '%', 'lower token cost'],
            [76, '%', 'faster executions'],
            [2, ' min', 'to install on an agent'],
          ] as Array<[number, string, string]>).map(([n, suffix, label]) => (
            <Reveal key={label}>
              <div style={{ textAlign: 'center' }}>
                <div className="h-serif" style={{ fontSize: 44, lineHeight: 1, color: 'var(--ink)' }}>
                  <CountUp to={n} suffix={suffix} />
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 8 }}>{label}</div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>

      {/* PROBLEM */}
      <Section>
        <Reveal>
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '0.9fr 1.1fr', gap: 60, alignItems: 'start' }}>
          <div>
            <Eyebrow hue="20">The problem</Eyebrow>
            <div className="h-serif" style={{ fontSize: 32, lineHeight: 1.25, marginBottom: 16 }}>Every execution starts almost from scratch.</div>
            <div style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.6, maxWidth: 380 }}>Agents re-derive the same answers run after run — burning tokens, time, and budget on work they&apos;ve already done.</div>
          </div>
          <div className="problems-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {problems.map((p) => (
              <div key={p.num} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 18, borderRadius: 12, background: p.bg, border: `1px solid ${p.border}` }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: p.numColor }}>{p.num}</div>
                <div style={{ fontSize: 14, color: 'oklch(0.28 0.012 260)', lineHeight: 1.45, fontWeight: 500 }}>{p.text}</div>
              </div>
            ))}
          </div>
        </div>
        </Reveal>
      </Section>

      {/* HOW IT WORKS */}
      <Section id="how">
        <Reveal>
        <Eyebrow hue="290">How it works</Eyebrow>
        <div className="h-serif" style={{ fontSize: 32, marginBottom: 44, maxWidth: 640 }}>Every execution becomes a graph. Every graph gets compiled down.</div>

        <div style={{ border: '1px solid var(--line)', borderRadius: 14, padding: '32px 28px 24px', background: 'oklch(0.995 0.002 90)' }}>
          <div className="arch-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 56px 1fr', gap: 8, alignItems: 'start' }}>
            <div>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: 'oklch(0.25 0.012 260)', marginBottom: 6 }}>Original Execution</div>
              <div style={{ display: 'flex', gap: 14, marginBottom: 26, flexWrap: 'wrap' }}>
                {originalStats.map((s, i) => <div key={i} style={{ fontSize: 12, color: 'var(--ink-3)' }}><span style={{ fontWeight: 600, color: 'oklch(0.3 0.012 260)' }}>{s.value}</span> {s.label}</div>)}
              </div>
              <Center><FlowNode scheme={SCHEMES.purple} label="Agent Starts" minWidth={180} delay={0.12} /></Center>
              <Line /><Center><FlowNode scheme={SCHEMES.purple} label="Planner (Opus 4.8)" minWidth={180} delay={0.24} /></Center>
              <Line />
              <div style={{ display: 'flex', gap: 14, justifyContent: 'center' }}>
                {['extractImports()', 'findRoutes()', 'analyzeDeps()'].map((g) => <VGroup key={g} label={g} minWidth={110} />)}
              </div>
              <Line /><Center><VGroup label="compiles to runTests()" minWidth={150} /></Center>
              <Line /><Center><FlowNode scheme={SCHEMES.green} label="Response" minWidth={180} /></Center>
            </div>

            <div className="arch-arrow" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 130 }}>
              <div style={{ width: 40, height: 40, borderRadius: '50%', border: `1px solid ${LINE}`, background: 'var(--cream)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: 'var(--ink-2)', animation: 'arrowPulse 2.6s ease-in-out infinite' }}>&rarr;</div>
            </div>

            <div>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--green)', marginBottom: 6 }}>Optimized Execution</div>
              <div style={{ display: 'flex', gap: 14, marginBottom: 26, flexWrap: 'wrap' }}>
                {optimizedStats.map((s, i) => <div key={i} style={{ fontSize: 12, color: 'var(--ink-3)' }}><span style={{ fontWeight: 600, color: 'var(--green)' }}>{s.value}</span> {s.label}</div>)}
              </div>
              <Center><FlowNode scheme={SCHEMES.purple} label="User Request" minWidth={180} /></Center>
              <Line color="var(--green-dot)" /><Center><FlowNode scheme={SCHEMES.purple} label="Planner (Sonnet 5)" minWidth={180} /></Center>
              <Line color="var(--green-dot)" /><Center><FlowNode scheme={SCHEMES.green} label="Knowledge Graph Lookup" glow minWidth={180} /></Center>
              <Line color="var(--green-dot)" />
              <div style={{ display: 'flex', gap: 14, justifyContent: 'center', position: 'relative', paddingTop: 16 }}>
                <div style={{ position: 'absolute', top: 0, left: '14%', right: '14%', height: 1, background: LINE }} />
                {['extractImports()', 'findRoutes()', 'analyzeDeps()'].map((l) => (
                  <div key={l} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ width: 1, height: 16, background: LINE }} />
                    <FlowNode scheme={SCHEMES.green} label={l} sub="Tool" mono minWidth={110} />
                  </div>
                ))}
              </div>
              <Line color="var(--green-dot)" /><Center><FlowNode scheme={SCHEMES.green} label="runTests()" sub="Tool" mono minWidth={180} /></Center>
              <Line color="var(--green-dot)" /><Center><FlowNode scheme={SCHEMES.gray} label="Small Model (Sonnet 5)" minWidth={180} /></Center>
              <Line color="var(--green-dot)" /><Center><FlowNode scheme={SCHEMES.green} label="Response" minWidth={180} /></Center>
            </div>
          </div>

          <div style={{ marginTop: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderRadius: 10, padding: '16px 22px', background: 'linear-gradient(100deg, oklch(0.95 0.03 290) 0%, oklch(0.93 0.035 270) 25%, oklch(0.95 0.03 290) 50%, oklch(0.93 0.035 270) 75%, oklch(0.95 0.03 290) 100%)', backgroundSize: '200% 100%', animation: 'shimmerMove 6s linear infinite' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, color: 'oklch(0.4 0.13 290)' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'oklch(0.55 0.16 290)' }} />Optimizer Impact
            </div>
            <div style={{ fontSize: 13, color: 'var(--green)', fontWeight: 500 }}>81% fewer steps &nbsp;·&nbsp; 76% faster &nbsp;·&nbsp; 76% cheaper</div>
          </div>
        </div>

        <div id="engine" className="engine-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 1, background: 'var(--line)', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', marginTop: 40 }}>
          {engineParts.map((e) => (
            <div key={e.name} style={{ background: 'var(--cream)', padding: '16px 18px' }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>{e.name}</div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.4 }}>{e.desc}</div>
            </div>
          ))}
        </div>
        </Reveal>
      </Section>

      {/* DETERMINISM SCORE */}
      <Section>
        <Reveal>
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '0.9fr 1.1fr', gap: 60, alignItems: 'center' }}>
          <div>
            <Eyebrow hue="85">Determinism engine</Eyebrow>
            <div className="h-serif" style={{ fontSize: 30, lineHeight: 1.25, marginBottom: 16 }}>Every node gets a determinism score, 0 to 100.</div>
            <div style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.6 }}>Scored on input/output stability, semantic similarity, historical variance, and repeat frequency — then routed automatically.</div>
          </div>
          <div>
            <div style={{ height: 10, borderRadius: 6, background: 'linear-gradient(to right, oklch(0.9 0.01 260) 0%, oklch(0.9 0.01 260) 70%, oklch(0.85 0.12 85) 70%, oklch(0.85 0.12 85) 90%, oklch(0.72 0.15 150) 90%, oklch(0.72 0.15 150) 100%)', marginBottom: 14, transformOrigin: 'left', animation: 'growIn 1.1s cubic-bezier(0.22,1,0.36,1) both' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)', marginBottom: 28 }}>
              <div>0</div><div>70</div><div>90</div><div>100</div>
            </div>
            {scoreBands.map((b) => (
              <div key={b.range} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', padding: '14px 0', borderTop: '1px solid oklch(0.92 0.005 90)' }}>
                <div style={{ width: 9, height: 9, borderRadius: '50%', background: b.color, marginTop: 5, flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{b.range} — {b.title}</div>
                  <div style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 2 }}>{b.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        </Reveal>
      </Section>

      {/* PRODUCT PREVIEW */}
      <Section>
        <Reveal>
          <Eyebrow hue="150">The product</Eyebrow>
          <div className="h-serif" style={{ fontSize: 32, marginBottom: 8, maxWidth: 620 }}>See every run. Then watch it get cheaper.</div>
          <div style={{ fontSize: 15, color: 'var(--ink-2)', marginBottom: 36, maxWidth: 620 }}>
            Every session lands as a navigable execution graph with per-model cost — and once an agent has history, the determinism engine turns it into concrete optimization actions.
          </div>
          <div className="preview-grid" style={{ display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', gap: 18, alignItems: 'stretch' }}>
            {/* sessions panel */}
            <div className="float-soft" style={{ borderRadius: 12, background: 'oklch(0.15 0.012 265)', border: '1px solid oklch(0.24 0.012 265)', overflow: 'hidden', boxShadow: '0 24px 60px -30px oklch(0.15 0.012 265 / 0.55)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid oklch(0.22 0.012 265)' }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'oklch(0.9 0.005 265)' }}>Sessions</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'oklch(0.55 0.01 265)' }}>184 runs · $1.77 total</div>
              </div>
              <div style={{ padding: '6px 0' }}>
                {([
                  ['seed-invo-021', 'invoice-reconciliation', '12', '$0.017', true],
                  ['seed-repo-014', 'repo-explorer', '12', '$0.021', true],
                  ['seed-tria-008', 'support-triage', '9', '$0.014', false],
                  ['seed-ci-004', 'ci-fixer', '11', '$0.012', false],
                  ['seed-docs-011', 'docs-writer', '7', '$0.016', false],
                ] as Array<[string, string, string, string, boolean]>).map(([id, agent, steps, cost, opt]) => (
                  <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 16px', borderBottom: '1px solid oklch(0.19 0.012 265)', fontSize: 11.5 }}>
                    <span style={{ fontFamily: 'var(--mono)', color: 'oklch(0.85 0.005 265)', width: 110, flexShrink: 0 }}>{id}</span>
                    <span style={{ color: 'oklch(0.65 0.01 265)', flex: 1, display: 'flex', alignItems: 'center', gap: 7 }}>
                      {agent}
                      {opt && <span style={{ fontSize: 9, fontWeight: 700, color: 'oklch(0.72 0.14 150)', border: '1px solid oklch(0.4 0.1 150)', borderRadius: 8, padding: '1px 7px' }}>Optimized</span>}
                    </span>
                    <span style={{ fontFamily: 'var(--mono)', color: 'oklch(0.6 0.01 265)' }}>{steps} steps</span>
                    <span style={{ fontFamily: 'var(--mono)', color: 'oklch(0.85 0.005 265)', width: 46, textAlign: 'right' }}>{cost}</span>
                  </div>
                ))}
              </div>
            </div>
            {/* insights panel */}
            <div className="float-soft" style={{ animationDelay: '0.8s', borderRadius: 12, background: 'oklch(0.15 0.012 265)', border: '1px solid oklch(0.24 0.012 265)', overflow: 'hidden', boxShadow: '0 24px 60px -30px oklch(0.15 0.012 265 / 0.55)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid oklch(0.22 0.012 265)' }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'oklch(0.9 0.005 265)' }}>Optimization Insights</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'oklch(0.55 0.01 265)' }}>last 40 runs</div>
              </div>
              <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {([
                  ['Replace with tool', 'planner turn', '100', 'oklch(0.72 0.14 150)'],
                  ['Memoize by input', 'tax_rate()', '100', 'oklch(0.75 0.12 210)'],
                  ['Synthesize template', 'report body', '89', 'oklch(0.72 0.12 250)'],
                  ['Route to smaller model', 'final summary', '80', 'oklch(0.7 0.12 290)'],
                ] as Array<[string, string, string, string]>).map(([action, target, score, color]) => (
                  <div key={action} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 9, padding: '2px 9px', whiteSpace: 'nowrap' }}>{action}</span>
                    <span style={{ fontFamily: 'var(--mono)', color: 'oklch(0.7 0.01 265)', flex: 1 }}>{target}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'oklch(0.88 0.005 265)' }}>{score}</span>
                  </div>
                ))}
                <div style={{ marginTop: 6, borderTop: '1px solid oklch(0.22 0.012 265)', paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 10.5, color: 'oklch(0.55 0.01 265)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Est. removable cost</span>
                  <span className="h-serif" style={{ fontSize: 22, color: 'oklch(0.72 0.14 150)' }}>$1.04 / run-set</span>
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </Section>

      {/* INSTALL */}
      <Section id="install">
        <Reveal>
          <Eyebrow hue="250">Universal installation</Eyebrow>
          <div className="h-serif" style={{ fontSize: 32, marginBottom: 8 }}>Install once. Change nothing.</div>
          <div style={{ fontSize: 15, color: 'var(--ink-2)', marginBottom: 36, maxWidth: 600 }}>
            One scoped key per agent, then pick the capture method for your harness — the engine is identical for every one of them.
          </div>
          <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)', overflowX: 'auto' }}>
            {installTabs.map((t) => (
              <div key={t.key} onClick={() => setTab(t.key)} style={{ padding: '10px 18px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', color: tab === t.key ? 'var(--ink)' : 'var(--ink-4)', borderBottom: tab === t.key ? '2px solid var(--ink)' : '2px solid transparent', marginBottom: -1 }}>{t.label}</div>
            ))}
          </div>
          <div style={{ background: 'oklch(0.16 0.012 260)', borderRadius: '0 0 8px 8px', padding: '26px 28px', fontFamily: 'var(--mono)', fontSize: 13.5, color: 'oklch(0.85 0.01 150)', lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>{INSTALL_CODE[tab]}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14, marginTop: 22 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)' }}>
              {supportedHarnesses.map((h) => <span key={h}>{h}</span>)}
            </div>
            <Link href="/developers" style={{ fontSize: 14, fontWeight: 600, color: 'oklch(0.4 0.14 250)' }}>Full developer guide &rarr;</Link>
          </div>
        </Reveal>
      </Section>

      {/* MANIFESTO */}
      <div style={{ position: 'relative', borderTop: '1px solid var(--line)', background: 'oklch(0.2 0.012 260)', padding: '100px 32px', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: '50%', left: '50%', width: 520, height: 340, transform: 'translate(-50%,-50%)', background: 'radial-gradient(ellipse, oklch(0.5 0.15 280 / 0.35), transparent 70%)', animation: 'glowPulse 4s ease-in-out infinite', pointerEvents: 'none' }} />
        <div style={{ position: 'relative', maxWidth: 780, margin: '0 auto', textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'oklch(0.6 0.01 260)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 24 }}>Positioning</div>
          <div className="h-serif" style={{ fontSize: 36, lineHeight: 1.35, color: 'oklch(0.98 0.004 90)' }}>Treat an AI agent as a program, not a sequence of prompts. Parse every execution into a universal graph, run compiler-like optimization passes, validate against history, and execute the optimized result.</div>
          <div style={{ fontSize: 15, color: 'oklch(0.68 0.01 260)', marginTop: 28 }}>The compiler for AI agents.</div>
        </div>
      </div>

      {/* PRICING TEASER */}
      <Section id="pricing">
        <Reveal>
          <div style={{ textAlign: 'center', marginBottom: 36 }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}><Eyebrow hue="150">Pricing</Eyebrow></div>
            <div className="h-serif" style={{ fontSize: 32, marginBottom: 10 }}>Start free. Scale when your fleet does.</div>
            <div style={{ fontSize: 15, color: 'var(--ink-2)' }}>Flat plans — never a percentage of your model spend.</div>
          </div>
          <div className="tier-mini-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
            {([
              ['Free', '$0', '2 agents · 1 GB'],
              ['Starter', '$15/mo', '5 agents · 20 GB'],
              ['Pro', '$80/mo', '20 agents · 100 GB'],
              ['Enterprise', 'Custom', 'Unlimited · Talk to us'],
            ] as Array<[string, string, string]>).map(([name, price, spec]) => (
              <Link key={name} href="/pricing" className="tier-mini" style={{ display: 'block', border: '1px solid var(--line)', borderRadius: 12, padding: '20px 20px', background: 'oklch(0.995 0.002 90)' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 6 }}>{name}</div>
                <div className="h-serif" style={{ fontSize: 26, marginBottom: 6 }}>{price}</div>
                <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{spec}</div>
              </Link>
            ))}
          </div>
          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <Link href="/pricing" style={{ fontSize: 14, fontWeight: 600, color: 'oklch(0.4 0.14 250)' }}>Compare all plans &rarr;</Link>
          </div>
        </Reveal>
      </Section>

      {/* FOOTER CTA */}
      <div style={{ borderTop: '1px solid var(--line)', padding: '90px 32px', textAlign: 'center' }}>
        <Reveal>
          <div className="h-serif" style={{ fontSize: 34, marginBottom: 26 }}>Stop paying your agents to think twice.</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
            <Link href="/developers" className="btn btn-primary" style={{ padding: '13px 26px', fontSize: 14.5, display: 'inline-block' }}>Install in 2 minutes</Link>
            <Link href="/security" className="btn btn-ghost" style={{ padding: '13px 22px', fontSize: 14.5, display: 'inline-block' }}>Security &amp; privacy</Link>
          </div>
        </Reveal>
      </div>

      {/* FOOTER */}
      <Footer />
    </div>
  );
}
