'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  SCHEMES, OUTCOME, problems, engineParts, installTabs, INSTALL_CODE,
  buildRuntimeGraph, supportedAgents, agentChips, platforms, spendVendors, leakKinds, type Scheme,
} from './data';
import { Nav, Footer } from './ui';
import { Reveal } from './reveal';
import { CountUp } from './countup';
import { CoverageTable } from './coverage';
import { DASHBOARD_URL, CONTACT_EMAIL } from './config';

const ACCENT = '#1a1d24';
const CONTENT = 1080;
const LINE = 'oklch(0.85 0.008 260)';
const RED = 'oklch(0.6 0.18 25)';
const AMBER = 'oklch(0.72 0.15 75)';
const LINK = 'oklch(0.4 0.14 250)';

const SIGN_UP = `${DASHBOARD_URL}/sign-up`;
const DEMO = `mailto:${CONTACT_EMAIL}?subject=Effigent%20demo`;

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

/** Dashed group: the part of a process tree a hook-only tool never sees. */
function Blind({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ border: `2px dashed ${RED}`, borderRadius: 12, padding: '10px 10px 4px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>{children}</div>
      <div style={{ textAlign: 'center', marginTop: 8, fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600, color: 'oklch(0.55 0.18 25)' }}>&rarr; {label}</div>
    </div>
  );
}

function Section({ id, children, tint }: { id?: string; children: ReactNode; tint?: boolean }) {
  const inner = <div id={tint ? undefined : id} className="section" style={{ maxWidth: CONTENT, margin: '0 auto', padding: '76px 32px', borderTop: tint ? 'none' : '1px solid var(--line)' }}>{children}</div>;
  if (!tint) return inner;
  return <div id={id} style={{ borderTop: '1px solid var(--line)', background: 'oklch(0.975 0.006 260)' }}>{inner}</div>;
}

function Eyebrow({ hue, children }: { hue: string; children: ReactNode }) {
  return <div className="eyebrow" style={{ color: `oklch(0.52 0.15 ${hue})` }}><span className="d" style={{ background: `oklch(0.58 0.17 ${hue})` }} />{children}</div>;
}

function H2({ children, max = 680 }: { children: ReactNode; max?: number }) {
  return <h2 className="h-serif" style={{ fontSize: 'clamp(26px, 6vw, 34px)', lineHeight: 1.22, margin: '0 0 14px', maxWidth: max }}>{children}</h2>;
}

function Lead({ children, max = 660, mb = 36 }: { children: ReactNode; max?: number; mb?: number }) {
  return <div style={{ fontSize: 16, color: 'var(--ink-2)', lineHeight: 1.65, maxWidth: max, marginBottom: mb }}>{children}</div>;
}

function Chip({ children, strong }: { children: ReactNode; strong?: boolean }) {
  return (
    <span className="chip" style={strong ? { borderStyle: 'dashed', color: 'var(--ink-2)' } : undefined}>
      {!strong && <span className="chip-dot" />}{children}
    </span>
  );
}

function Check({ color = 'var(--green)' }: { color?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }}>
      <circle cx="8" cy="8" r="7.5" fill="none" stroke={color} strokeOpacity="0.35" />
      <path d="M4.6 8.2 7 10.5l4.4-5" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** One row of the process tree in the "How it works" diagram. */
function TreeRow({ depth, label, note, scheme, glow }: { depth: number; label: string; note: string; scheme: Scheme; glow?: boolean }) {
  return (
    <div className="tree-row" style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: depth * 18, minWidth: 0 }}>
      {depth > 0 && <span aria-hidden="true" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-4)', flexShrink: 0 }}>└</span>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', border: `1px solid ${scheme.border}`, background: scheme.bg, borderRadius: 8, padding: '6px 10px', minWidth: 0, animation: glow ? 'pulseGlow 2.2s ease-in-out infinite' : undefined }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: scheme.dot, flexShrink: 0 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: scheme.text, overflowWrap: 'anywhere' }}>{label}</span>
        <span style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{note}</span>
      </div>
    </div>
  );
}

/** Horizontal connector between diagram panels (vertical on phones via CSS). */
function Connector({ top, bottom }: { top: string; bottom: string }) {
  return (
    <div className="flow-conn" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 22, minWidth: 0 }}>
      {[[top, '→', 'oklch(0.55 0.15 250)'], [bottom, '←', 'oklch(0.55 0.15 150)']].map(([label, arrow, color]) => (
        <div key={label} style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', marginBottom: 4, lineHeight: 1.3 }}>{label}</div>
          <div className="flow-conn-line" style={{ position: 'relative', height: 2, background: LINE, borderRadius: 1 }}>
            <span style={{ position: 'absolute', top: -2, left: 0, width: 6, height: 6, borderRadius: '50%', background: color, animation: `${arrow === '→' ? 'flowRight' : 'flowLeft'} 1.8s linear infinite` }} />
          </div>
          <div aria-hidden="true" style={{ fontSize: 12, color: 'var(--ink-4)', marginTop: 2 }}><span className="flow-conn-h">{arrow}</span><span className="flow-conn-v">{arrow === '→' ? '↓' : '↑'}</span></div>
        </div>
      ))}
    </div>
  );
}

const OUTCOME_LABEL: Record<string, string> = { allowed: 'allowed', observed: 'recorded', pending: 'needs approval', blocked: 'blocked' };

const APPROVAL_STATES: Array<[string, string, string]> = [
  ['paused', 'Hook holds the tool call', SCHEMES.amber.dot],
  ['approval_pending', 'Routed to payments-leads in Slack and email', SCHEMES.amber.dot],
  ['approved', 'maya.cohen · “release branch, coordinated”', SCHEMES.green.dot],
  ['revalidated', 'Same fingerprint, policy v42 still applies', SCHEMES.green.dot],
  ['resumed', 'The push runs once', SCHEMES.green.dot],
];

const EVENTS: Array<[string, keyof typeof OUTCOME | 'would', string, string, string]> = [
  ['14:32', 'blocked', 'claude-code', 'exec', '/usr/bin/curl https://paste.example.net'],
  ['14:30', 'pending', 'codex', 'exec', 'npm install left-pad-pro@2.1.0'],
  ['14:29', 'allowed', 'claude-code', 'mcp', 'github.create_pull_request'],
  ['14:27', 'observed', 'codex', 'connect', 'api.openai.com:443'],
  ['14:21', 'would', 'gemini-cli', 'exec', '/usr/bin/wget (monitor mode)'],
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

/** Illustrative Pricing Leaks report. Every figure is a made-up example. */
const EXAMPLE_LEAKS: Array<[string, string, string, string]> = [
  ['Unused seats', '6 Cursor seats with no agent activity in 30 days', '$240', '25'],
  ['Duplicate tools', '4 developers pay for Copilot and Claude Code, run only Claude Code', '$76', '75'],
  ['Shadow spend', 'Codex on 3 machines with no organisation seat', 'review', '290'],
  ['Runaway costs', 'claude-code in CI at 9× the team median', '$410', '250'],
];

const ROLES: Array<{ who: string; hue: string; title: string; points: string[] }> = [
  {
    who: 'Security & CISO', hue: '25', title: 'Control without banning agents.',
    points: ['Every command, file, connection and MCP call tied to the agent, user and machine', 'Secrets, exfiltration hosts and risky binaries blocked in the kernel', 'Rules for prod: DROP TABLE, terraform destroy or a push to main can need two people', 'Tamper-evident audit trail, and an alert when a hook is removed or a daemon stops'],
  },
  {
    who: 'Platform & DevEx', hue: '250', title: 'One daemon. No agent changes.',
    points: ['Laptops, servers, CI runners, Kubernetes pods and cloud agents from one console', 'Monitor first, then enforce per team, agent or machine', 'Hosted, or self-hosted with your own OIDC sign-in', 'API keys and signed webhooks for your own automation'],
  },
  {
    who: 'Engineering leadership', hue: '150', title: 'Say yes to the agents your team wants.',
    points: ['Approvals for the few actions that matter: git push, prod, secrets', 'One policy covers every agent, whichever model drives it', 'A posture report every week: agents, MCP servers, blocks and approvals', 'Pricing Leaks finds the AI spend you can cut'],
  },
];

/** "Beyond the command" cards: title, text, docs page, accent hue. */
const BEYOND: Array<[string, string, string, string]> = [
  ['Actions & environments', 'Git pushes to protected branches, SQL writes, cloud changes and package installs, each with its target: the AWS account, kube context, Terraform workspace or database host. Rules can say prod only.', '/docs/actions', '25'],
  ['Packages', 'Installs are checked against your allow and deny lists, your registries and the OSV feed of malicious and vulnerable packages, before they run.', '/docs/actions', '75'],
  ['Cloud agents & containers', 'Claude Code on the web, the GitHub Copilot coding agent and Cursor background agents ask Effigent through the repository’s hooks. Agents in pods use the node’s hook socket.', '/docs/cloud-agents', '250'],
  ['Model gateway', 'Choose the models each agent may use, cap output tokens and record the tokens of every Claude Code and Codex model call.', '/docs/model-gateway', '290'],
  ['Inventory & posture report', 'Every agent and MCP server on every machine, the people using AI tools outside any managed machine, what is new this week, and a weekly report by email.', '/docs/inventory', '150'],
  ['Self-hosted', 'Run the control plane and console in your own Kubernetes cluster or on one host, with Okta, Entra ID, Keycloak or any OIDC provider for sign-in.', '/docs/self-hosting', '200'],
];

const STEPS: Array<[string, string]> = [
  ['Publish', 'Write one policy in the console. It is versioned and signed.'],
  ['Apply', 'effigentd on every machine verifies it and keeps it offline.'],
  ['Attribute', 'Each process, file, connection and MCP call is tied to its agent.'],
  ['Enforce', 'Hooks and the kernel allow, block or pause for approval.'],
  ['Prove', 'Every decision lands in a hash-chained audit trail.'],
];

export default function Page() {
  const [tab, setTab] = useState(installTabs[0].key); // first tab — never a stale key
  const graph = buildRuntimeGraph();

  // Mobile "Scripts can't hide": the two views become a swipeable slider, and
  // the first time the section scrolls into view we animate hook-only →
  // Effigent once. Any touch cancels the tour; desktop and
  // prefers-reduced-motion keep the static side-by-side.
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

      {/* HERO — what it is, who it's for, why now */}
      <div style={{ position: 'relative', background: 'linear-gradient(180deg, oklch(0.95 0.018 275) 0%, oklch(0.97 0.012 275) 55%, oklch(0.985 0.004 90) 100%)', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(oklch(0.75 0.03 275 / 0.5) 1px, transparent 1px)', backgroundSize: '22px 22px', maskImage: 'radial-gradient(ellipse 70% 60% at 50% 20%, black 40%, transparent 100%)', WebkitMaskImage: 'radial-gradient(ellipse 70% 60% at 50% 20%, black 40%, transparent 100%)' }} />
        <div className="hero-pad" style={{ position: 'relative', maxWidth: CONTENT, margin: '0 auto', padding: '104px 32px 64px' }}>
          <div className="hero-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 440px', gap: 56, alignItems: 'center' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 12.5, color: 'oklch(0.4 0.012 260)', border: '1px solid oklch(0.85 0.01 275)', background: 'oklch(0.99 0.004 275 / 0.7)', borderRadius: 20, padding: '6px 14px', marginBottom: 24 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green-dot)' }} />The AI Agent Control Plane
              </div>
              <h1 className="h-serif" style={{ fontSize: 'clamp(34px, 8vw, 56px)', lineHeight: 1.08, margin: '0 0 22px' }}>
                Give every developer AI coding agents. <b>Keep control of what they do.</b>
              </h1>
              <div style={{ fontSize: 17.5, color: 'var(--ink-2)', lineHeight: 1.65, maxWidth: 560, marginBottom: 28 }}>
                Effigent puts one lightweight daemon on every laptop, server and Kubernetes node. It recognises each coding agent, ties every command, file, connection and MCP call to the agent that caused it, and enforces your policy on the machine, down to the kernel. Built for security, platform and engineering leaders.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 30 }}>
                <a href={SIGN_UP} className="btn btn-primary" style={{ padding: '13px 26px', fontSize: 15, display: 'inline-block' }}>Get started free</a>
                <a href={DEMO} className="btn btn-ghost" style={{ padding: '13px 22px', fontSize: 15, display: 'inline-block', background: 'oklch(0.995 0.002 90 / 0.7)' }}>Book a demo</a>
                <Link href="/docs" style={{ padding: '13px 6px', fontSize: 15, fontWeight: 650, color: LINK }}>Read the docs &rarr;</Link>
              </div>
              <div className="hero-points" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px 22px', maxWidth: 560 }}>
                {[
                  ['See', 'every agent and every action, attributed'],
                  ['Control', 'block or require approval, on the machine'],
                  ['Prove', 'a tamper-evident record of every decision'],
                  ['Save', 'find unused and duplicate AI spend'],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', gap: 9, fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.45 }}>
                    <Check />
                    <span><b style={{ color: 'var(--ink)' }}>{k}</b> {v}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="hero-graph" style={{ position: 'relative', border: '1px solid var(--line)', borderRadius: 14, background: 'oklch(0.995 0.002 90)', padding: 18, boxShadow: '0 20px 50px -24px oklch(0.2 0.012 260 / 0.25)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10, padding: '0 4px' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Agent graph · alex-mbp</div>
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

          {/* supported agents, at a glance */}
          <div style={{ marginTop: 48, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '10px 14px' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-3)', marginRight: 4 }}>Works with</span>
            {agentChips.map((a) => <Chip key={a} strong={a === 'Any custom agent'}>{a}</Chip>)}
          </div>
        </div>
      </div>

      {/* PLATFORMS — marquee */}
      <div style={{ borderTop: '1px solid var(--line)', padding: '20px 0', background: 'oklch(0.975 0.004 90)' }}>
        <div className="marquee">
          <div className="marquee-track">
            {[0, 1].map((dup) => (
              <div key={dup} style={{ display: 'flex', gap: 56 }} aria-hidden={dup === 1}>
                {[...platforms, 'Kernel enforcement · eBPF', 'Agent hooks', 'MCP servers', 'Model gateway', 'Signed policies', 'Offline enforcement', 'Slack · email approvals', 'Self-hosted'].map((h) => (
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
            [supportedAgents.length, '', 'coding agents recognised out of the box, plus any you add'],
            [spendVendors.length, '', 'AI vendor billing APIs joined for Pricing Leaks'],
            [3, '', 'decisions: allow, deny, require approval'],
            [1, '', 'action per approval. Never a blanket yes.'],
          ] as Array<[number, string, string]>).map(([n, suffix, label]) => (
            <Reveal key={label}>
              <div style={{ textAlign: 'center' }}>
                <div className="h-serif" style={{ fontSize: 'clamp(30px, 6vw, 44px)', lineHeight: 1, color: 'var(--ink)' }}>
                  <CountUp to={n} suffix={suffix} duration={0.9} />
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 8, lineHeight: 1.45 }}>{label}</div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>

      {/* WHY NOW */}
      <Section>
        <Reveal>
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '0.9fr 1.1fr', gap: 60, alignItems: 'start' }}>
          <div>
            <Eyebrow hue="20">Why now</Eyebrow>
            <H2>Agents now run as <b>your developers</b>, with their keys.</H2>
            <div style={{ fontSize: 15.5, color: 'var(--ink-2)', lineHeight: 1.65, maxWidth: 420 }}>
              Coding agents install packages, read config, open connections, call MCP tools and push code, with the developer&apos;s SSH keys, cloud credentials and push rights. Most of it is fine. These are the moments that aren&apos;t, and none of them needs a bad prompt.
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

      {/* WHO IT'S FOR */}
      <Section tint>
        <Reveal>
          <Eyebrow hue="290">Who it&apos;s for</Eyebrow>
          <H2>One control plane for everyone <b>accountable for AI agents</b>.</H2>
          <Lead>Developers keep the agents they like. The people responsible for security, infrastructure and budget get the controls and the record they need.</Lead>
          <div className="roles-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            {ROLES.map((r) => (
              <div key={r.who} className="tier-card" style={{ border: '1px solid var(--line)', borderRadius: 14, padding: '22px 22px 20px', background: 'oklch(0.995 0.002 90)', borderTop: `3px solid oklch(0.6 0.15 ${r.hue})` }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: `oklch(0.5 0.14 ${r.hue})`, fontWeight: 650, marginBottom: 8 }}>{r.who}</div>
                <div style={{ fontSize: 17, fontWeight: 720, marginBottom: 14, lineHeight: 1.3 }}>{r.title}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {r.points.map((pt) => (
                    <div key={pt} style={{ display: 'flex', gap: 9, fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.5 }}>
                      <Check color={`oklch(0.55 0.15 ${r.hue})`} />{pt}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Reveal>
      </Section>

      {/* HOW IT WORKS — control plane → machine → team */}
      <Section id="how">
        <Reveal>
          <Eyebrow hue="250">How it works</Eyebrow>
          <H2 max={720}>Policy from the control plane. <b>Enforcement on the machine.</b></H2>
          <Lead max={680}>
            You write one policy. effigentd on each machine verifies its signature, follows every agent&apos;s process tree, and decides each action locally, in the agent&apos;s hooks and in the kernel. It keeps enforcing when the network is gone. Whatever model drives the agent, on whatever machine you run it: laptops, servers, CI runners and <Link href="/docs/kubernetes" style={{ color: LINK, fontWeight: 600 }}>Kubernetes nodes</Link>.
          </Lead>

          <div className="flow-diagram" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 0.95fr) 92px minmax(0, 1.45fr) 92px minmax(0, 0.9fr)', alignItems: 'stretch', gap: 0 }}>
            {/* control plane */}
            <div style={{ borderRadius: 14, background: 'oklch(0.18 0.012 265)', border: '1px solid oklch(0.26 0.012 265)', padding: 18, color: 'oklch(0.92 0.005 265)', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: '0 24px 50px -30px oklch(0.15 0.012 265 / 0.6)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- static export, no optimizer */}
                <img src="/email/effigent-icon.png" alt="" width={20} height={20} style={{ borderRadius: 5, display: 'block' }} />
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>Effigent control plane</div>
              </div>
              {[
                ['Policy v42', 'versioned · Ed25519-signed', 'oklch(0.72 0.12 250)'],
                ['Approvals', 'Slack · email · console', 'oklch(0.78 0.13 80)'],
                ['Audit trail', 'append-only · hash-chained', 'oklch(0.72 0.12 290)'],
                ['Pricing Leaks', 'seats · usage · cost', 'oklch(0.72 0.13 150)'],
              ].map(([t, s, c]) => (
                <div key={t} style={{ borderRadius: 8, border: '1px solid oklch(0.28 0.012 265)', background: 'oklch(0.21 0.012 265)', padding: '9px 11px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 650 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: c }} />{t}</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'oklch(0.62 0.01 265)', marginTop: 2 }}>{s}</div>
                </div>
              ))}
            </div>

            <Connector top="signed policy" bottom="events · requests" />

            {/* the machine */}
            <div style={{ borderRadius: 14, border: '1px solid var(--line-2)', background: 'oklch(0.995 0.002 90)', padding: 18, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 24px 50px -30px oklch(0.2 0.012 260 / 0.3)', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>Developer laptop · server · node</div>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 650, color: 'var(--green)', border: '1px solid oklch(0.82 0.08 150)', background: 'oklch(0.97 0.03 150)', borderRadius: 10, padding: '2px 9px' }}>effigentd</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <TreeRow depth={0} label="Claude Code" note="agent · pid 48211" scheme={SCHEMES.purple} />
                <TreeRow depth={1} label="python3 fix.py" note="hook: tool call checked" scheme={SCHEMES.blue} />
                <TreeRow depth={2} label="sh -c …" note="kernel: attributed" scheme={SCHEMES.green} />
                <TreeRow depth={3} label="curl paste.example.net" note="kernel: EPERM" scheme={SCHEMES.red} glow />
              </div>
              <div className="layer-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 'auto' }}>
                <div style={{ borderRadius: 8, background: SCHEMES.blue.bg, border: `1px solid ${SCHEMES.blue.border}`, padding: '8px 10px' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: SCHEMES.blue.text }}>Agent hooks</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.4 }}>the exact command, file, URL or MCP tool</div>
                </div>
                <div style={{ borderRadius: 8, background: SCHEMES.red.bg, border: `1px solid ${SCHEMES.red.border}`, padding: '8px 10px' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: SCHEMES.red.text }}>Kernel · eBPF</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.4 }}>every child process, file and connection</div>
                </div>
              </div>
            </div>

            <Connector top="approval request" bottom="decision" />

            {/* the team */}
            <div style={{ borderRadius: 14, border: '1px solid var(--line)', background: 'oklch(0.995 0.002 90)', padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>Your team</div>
              {[
                ['Approve', 'git push --force · once', SCHEMES.amber],
                ['Investigate', 'who ran what, under which rule', SCHEMES.blue],
                ['Save', 'unused and duplicate seats', SCHEMES.green],
              ].map(([t, s, sc]) => {
                const scheme = sc as Scheme;
                return (
                  <div key={t as string} style={{ borderRadius: 8, border: `1px solid ${scheme.border}`, background: scheme.bg, padding: '9px 11px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 700, color: scheme.text }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: scheme.dot }} />{t as string}</div>
                    <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>{s as string}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <ol className="steps-row" style={{ listStyle: 'none', padding: 0, margin: '34px 0 0', display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 1, background: 'var(--line)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
            {STEPS.map(([t, d], i) => (
              <li key={t} style={{ background: 'var(--cream)', padding: '14px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%', background: 'var(--ink)', color: 'var(--cream)', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700 }}>{i + 1}</span>
                  <span style={{ fontSize: 13.5, fontWeight: 700 }}>{t}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.45 }}>{d}</div>
              </li>
            ))}
          </ol>
        </Reveal>
      </Section>

      {/* DIFFERENTIATOR — kernel follows every child process */}
      <Section id="kernel">
        <Reveal>
        <Eyebrow hue="25">Scripts can&apos;t hide</Eyebrow>
        <H2 max={720}>A hook sees the command the agent typed. <b>The kernel sees what actually runs.</b></H2>
        <Lead max={680}>
          Agents write scripts and then run them. A hook-only tool checks <code style={{ fontFamily: 'var(--mono)', fontSize: 14 }}>python3 fix.py</code>, finds nothing wrong, and never sees the <code style={{ fontFamily: 'var(--mono)', fontSize: 14 }}>curl</code> three processes later. An LLM gateway sees even less: the model call. effigentd enforces in the kernel with eBPF and BPF LSM, scoped to each agent&apos;s whole process tree, so every child process is attributed to the agent and checked before it runs.
        </Lead>

        <div className="arch-panel" style={{ border: '1px solid var(--line)', borderRadius: 14, padding: '32px 28px 24px', background: 'oklch(0.995 0.002 90)' }}>
          {/* mobile-only slider control — hidden on desktop via CSS */}
          <div className="arch-switch" role="tablist" aria-label="Hook-only vs Effigent view">
            {['Hook-only', 'Effigent'].map((label, i) => (
              <button key={label} role="tab" aria-selected={archSlide === i} className={archSlide === i ? 'on' : ''} onClick={() => archGoTo(i)}>
                {label}
              </button>
            ))}
          </div>
          <div ref={archRef} onScroll={onArchScroll} className="arch-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 56px 1fr', gap: 8, alignItems: 'start' }}>
            <div className="arch-col">
              <div style={{ fontSize: 14.5, fontWeight: 700, color: 'oklch(0.25 0.012 260)', marginBottom: 6 }}>What a hook-only tool sees</div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 26 }}>1 tool call checked · 3 processes never seen</div>
              <Center><FlowNode scheme={SCHEMES.purple} label="Claude Code" sub="alex-mbp · ~/src/payments" minWidth={200} delay={0.12} /></Center>
              <Line /><Center><FlowNode scheme={SCHEMES.blue} label="Bash: python3 fix.py" sub="hook: looks fine → allowed" mono minWidth={200} delay={0.24} /></Center>
              <Line />
              <Center>
                <Blind label="invisible to the hook">
                  <FlowNode scheme={SCHEMES.gray} label="python3 fix.py" mono minWidth={170} />
                  <Line h={16} /><FlowNode scheme={SCHEMES.gray} label="sh -c …" mono minWidth={170} />
                  <Line h={16} /><FlowNode scheme={SCHEMES.red} label="curl paste.example.net" mono minWidth={170} />
                </Blind>
              </Center>
              <Line /><Center><FlowNode scheme={SCHEMES.red} label="~/.aws/credentials leaves" minWidth={200} /></Center>
            </div>

            <div className="arch-arrow" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 150 }}>
              <div style={{ width: 40, height: 40, borderRadius: '50%', border: `1px solid ${LINE}`, background: 'var(--cream)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: 'var(--ink-2)', animation: 'arrowPulse 2.6s ease-in-out infinite' }}>&rarr;</div>
            </div>

            <div className="arch-col">
              <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--green)', marginBottom: 6 }}>What Effigent sees and does</div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 26 }}>Every child attributed · 1 kernel block · full audit</div>
              <Center><FlowNode scheme={SCHEMES.purple} label="Claude Code" sub="pid 48211 · tracked since start" minWidth={200} /></Center>
              <Line color="var(--green-dot)" /><Center><FlowNode scheme={SCHEMES.blue} label="Hook: python3 fix.py" sub="tool call checked · allowed" mono minWidth={200} /></Center>
              <Line color="var(--green-dot)" /><Center><FlowNode scheme={SCHEMES.green} label="python3 fix.py" sub="exec · attributed to claude-code" mono minWidth={200} /></Center>
              <Line color="var(--green-dot)" /><Center><FlowNode scheme={SCHEMES.green} label="sh -c …" sub="exec · allowed" mono minWidth={200} /></Center>
              <Line color={RED} /><Center><FlowNode scheme={SCHEMES.red} label="/usr/bin/curl" sub="kernel: EPERM · exec_deny" mono glow minWidth={200} /></Center>
              <Line color="var(--green-dot)" /><Center><FlowNode scheme={SCHEMES.gray} label="Audit: 4 processes, 1 block" minWidth={200} /></Center>
            </div>
          </div>

          <div style={{ marginTop: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, borderRadius: 10, padding: '16px 22px', background: 'linear-gradient(100deg, oklch(0.96 0.015 250) 0%, oklch(0.945 0.02 240) 25%, oklch(0.96 0.015 250) 50%, oklch(0.945 0.02 240) 75%, oklch(0.96 0.015 250) 100%)', backgroundSize: '200% 100%', animation: 'shimmerMove 6s linear infinite' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, color: 'oklch(0.38 0.1 250)' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'oklch(0.55 0.14 250)' }} />Kernel-level enforcement
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
            <H2>Approve this push. <b>Not all pushes.</b></H2>
            <div style={{ fontSize: 15.5, color: 'var(--ink-2)', lineHeight: 1.65, marginBottom: 22 }}>
              A <code style={{ fontFamily: 'var(--mono)', fontSize: 13.5 }}>require_approval</code>{' '}rule holds the agent&apos;s tool call and asks the people the rule names, in Slack, by email or in the console. The approval covers one action: the command, the directory, the session, the machine and the user, hashed into a fingerprint.
            </div>
            {[
              ['Single-use', 'It resumes that call once. The next force-push asks again.'],
              ['Bound to the exact action', 'Change one argument and it is a different fingerprint, so a new request.'],
              ['Routed to the right people', 'Approver groups per kind of action: AWS changes to DevOps, outside hosts to security.'],
              ['Two people when it matters', 'A rule can need two approvers and a ticket. Nobody approves their own request.'],
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

      {/* PRICING LEAKS */}
      <Section id="pricing-leaks" tint>
        <Reveal>
          <div className="leaks-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 56, alignItems: 'start' }}>
            <div>
              <Eyebrow hue="150">Pricing Leaks</Eyebrow>
              <H2>Find the AI spend <b>nobody is using</b>.</H2>
              <div style={{ fontSize: 15.5, color: 'var(--ink-2)', lineHeight: 1.65, marginBottom: 18 }}>
                Effigent connects to the admin and billing APIs of your AI coding tools and joins seats, usage and cost with what effigentd sees actually running on each machine. Findings come with an estimated monthly saving (shadow spend with the spend at risk), so Effigent can pay for itself. A runaway cost, like an agent looping in CI, is flagged after the next daily vendor sync, so within a day, and emailed and sent to the webhooks subscribed to it.
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 26 }}>
                {spendVendors.map((v) => <Chip key={v}>{v}</Chip>)}
              </div>
              <div className="leak-kinds" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {leakKinds.map((k) => (
                  <div key={k.title} style={{ borderRadius: 12, padding: '14px 16px', background: 'oklch(0.995 0.002 90)', border: '1px solid var(--line)', borderLeft: `3px solid oklch(0.62 0.15 ${k.hue})` }}>
                    <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{k.title}</div>
                    <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5, marginBottom: 6 }}>{k.text}</div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)' }}>{k.signal}</div>
                  </div>
                ))}
              </div>
              <Link href="/docs/pricing-leaks" style={{ display: 'inline-block', marginTop: 18, fontSize: 14, fontWeight: 600, color: LINK }}>How Pricing Leaks works &rarr;</Link>
            </div>

            {/* illustrative report — every number is an example */}
            <div style={{ minWidth: 0 }}>
              <div className="float-soft" style={{ borderRadius: 14, background: 'oklch(0.995 0.002 90)', border: '1px solid var(--line-2)', boxShadow: '0 24px 50px -28px oklch(0.2 0.012 260 / 0.35)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>Pricing Leaks · this month</div>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: SCHEMES.amber.text, background: SCHEMES.amber.bg, border: `1px solid ${SCHEMES.amber.border}`, borderRadius: 10, padding: '3px 10px' }}>Example</span>
                </div>
                <div>
                  {EXAMPLE_LEAKS.map(([kind, finding, saving, hue]) => (
                    <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', borderBottom: '1px solid var(--line)' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: `oklch(0.62 0.15 ${hue})`, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{kind}</div>
                        <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.45 }}>{finding}</div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 13.5, fontWeight: 700, color: saving === 'review' ? 'var(--ink-3)' : 'var(--green)' }}>{saving}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--ink-4)' }}>{saving === 'review' ? 'unbudgeted' : '/ month'}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '14px 18px', background: 'oklch(0.97 0.03 150)' }}>
                  <div style={{ fontSize: 13, fontWeight: 650, color: 'oklch(0.35 0.12 150)' }}>Estimated saving</div>
                  <div className="h-serif" style={{ fontSize: 26, color: 'oklch(0.35 0.12 150)' }}><b>$726</b><span style={{ fontSize: 13, fontWeight: 500 }}> / month</span></div>
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-4)', marginTop: 10, textAlign: 'center' }}>Illustrative example. Figures are not customer data.</div>
            </div>
          </div>
        </Reveal>
      </Section>

      {/* WHAT EFFIGENT COVERS */}
      <Section id="coverage">
        <Reveal>
          <Eyebrow hue="150">What Effigent covers</Eyebrow>
          <H2 max={700}>Every kind of agent action, <b>with a decision attached</b>.</H2>
          <Lead max={680} mb={30}>
            Agent hooks see the exact command, file, URL or MCP tool the agent asks for. The kernel sees every process the agent starts after that. Together they block, pause for approval and record each action, whichever agent runs it.
          </Lead>
          <CoverageTable />
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14, marginTop: 18 }}>
            <div style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6, maxWidth: 680 }}>
              <b style={{ color: 'var(--ink-2)' }}>Block</b> stops it before it runs. <b style={{ color: 'var(--ink-2)' }}>Require approval</b> holds it for a named reviewer. <b style={{ color: 'var(--ink-2)' }}>Audit</b> records it with the rule and policy version. In monitor mode every match is reported as <code style={{ fontFamily: 'var(--mono)' }}>would_block</code> first.
            </div>
            <Link href="/docs/enforcement" style={{ fontSize: 14, fontWeight: 600, color: LINK, whiteSpace: 'nowrap' }}>How enforcement works &rarr;</Link>
          </div>
        </Reveal>
      </Section>

      {/* BEYOND THE COMMAND — what each call means, and where agents run */}
      <Section id="beyond" tint>
        <Reveal>
          <Eyebrow hue="290">Beyond the command</Eyebrow>
          <H2 max={720}>Rules for what an action <b>does</b>, wherever the agent runs.</H2>
          <Lead max={680} mb={30}>
            A push to main, a DROP TABLE on the prod database, a terraform destroy in the prod workspace: Effigent reads what each tool call does and which environment it touches, and decides on that. The same policy follows agents into containers, into the vendor&apos;s cloud and down to the model they call.
          </Lead>
          <div className="beyond-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14 }}>
            {BEYOND.map(([title, text, href, hue]) => (
              <Link key={href} href={href} className="tier-card" style={{ display: 'block', border: '1px solid var(--line)', borderRadius: 12, padding: '18px 20px', background: 'oklch(0.995 0.002 90)', borderTop: `3px solid oklch(0.6 0.15 ${hue})` }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{title}</div>
                <div style={{ fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.55, marginBottom: 10 }}>{text}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: LINK }}>Read more &rarr;</div>
              </Link>
            ))}
          </div>
        </Reveal>
      </Section>

      {/* THE CONSOLE */}
      <Section>
        <Reveal>
          <Eyebrow hue="250">The console</Eyebrow>
          <H2 max={640}>One place for the rules and <b>the record</b>.</H2>
          <Lead max={640}>
            Write a policy once, scope it to teams, agents or machines, and every enrolled endpoint picks it up within seconds. Each event says which agent did it, on whose machine, which rule decided it and at which policy version.
          </Lead>
          <div className="console-grid" style={{ display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', gap: 18, alignItems: 'stretch' }}>
            {/* events panel */}
            <div className="float-soft" style={{ borderRadius: 12, background: 'oklch(0.15 0.012 265)', border: '1px solid oklch(0.24 0.012 265)', overflow: 'hidden', boxShadow: '0 24px 60px -30px oklch(0.15 0.012 265 / 0.55)', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid oklch(0.22 0.012 265)' }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'oklch(0.9 0.005 265)' }}>Events</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'oklch(0.55 0.01 265)' }}>production · last 15 min</div>
              </div>
              <div style={{ padding: '6px 0' }}>
                {EVENTS.map(([time, outcome, agent, cls, target]) => {
                  const color = outcome === 'would' ? 'oklch(0.7 0.1 60)' : OUTCOME[outcome];
                  const label = outcome === 'would' ? 'would_block' : outcome === 'observed' ? 'recorded' : outcome;
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
          <H2>One daemon per machine. <b>No agent code changes.</b></H2>
          <Lead max={620}>
            Enroll a machine with a token from the console. effigentd picks up agents already running, installs the hooks for the agents that have them, and starts in the mode your policy sets.
          </Lead>
          <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)', overflowX: 'auto' }} role="tablist">
            {installTabs.map((t) => (
              <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} style={{ padding: '10px 18px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', background: 'transparent', border: 'none', fontFamily: 'var(--sans)', color: tab === t.key ? 'var(--ink)' : 'var(--ink-4)', borderBottom: tab === t.key ? '2px solid var(--ink)' : '2px solid transparent', marginBottom: -1 }}>{t.label}</button>
            ))}
          </div>
          <div className="install-code" style={{ background: 'oklch(0.16 0.012 260)', borderRadius: '0 0 8px 8px', padding: '26px 28px', fontFamily: 'var(--mono)', fontSize: 13.5, color: 'oklch(0.85 0.01 150)', lineHeight: 1.8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{INSTALL_CODE[tab]}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14, marginTop: 22 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)' }}>
              {[...supportedAgents, 'Any custom agent'].map((h) => <span key={h}>{h}</span>)}
            </div>
            <Link href="/docs/quickstart" style={{ fontSize: 14, fontWeight: 600, color: LINK }}>Quickstart &rarr;</Link>
          </div>
        </Reveal>
      </Section>

      {/* POSITION */}
      <div className="manifesto-pad" style={{ position: 'relative', borderTop: '1px solid var(--line)', background: 'oklch(0.2 0.012 260)', padding: '100px 32px', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(oklch(0.4 0.012 260 / 0.6) 1px, transparent 1px)', backgroundSize: '22px 22px', maskImage: 'radial-gradient(ellipse 60% 70% at 50% 50%, black 30%, transparent 100%)', WebkitMaskImage: 'radial-gradient(ellipse 60% 70% at 50% 50%, black 30%, transparent 100%)', pointerEvents: 'none' }} />
        <div style={{ position: 'relative', maxWidth: 780, margin: '0 auto', textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'oklch(0.6 0.01 260)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 24 }}>Where the control sits</div>
          <div className="h-serif" style={{ fontSize: 'clamp(24px, 6.5vw, 36px)', lineHeight: 1.35, color: 'oklch(0.98 0.004 90)' }}>The decision belongs <b>on the machine</b>, before the exec, with a name next to every exception.</div>
          <div style={{ fontSize: 15, color: 'oklch(0.68 0.01 260)', marginTop: 28, maxWidth: 600, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.65 }}>Prompts and model calls are the wrong place to enforce what a shell may do. effigentd enforces where the action happens, follows every process the agent starts, and keeps enforcing offline.</div>
        </div>
      </div>

      {/* FOOTER CTA */}
      <div className="cta-pad" style={{ borderTop: '1px solid var(--line)', padding: '90px 32px', textAlign: 'center' }}>
        <Reveal>
          <div className="h-serif" style={{ fontSize: 'clamp(27px, 7vw, 38px)', marginBottom: 12 }}>Start in monitor mode. <b>Enforce when you&apos;re ready.</b></div>
          <div style={{ fontSize: 15.5, color: 'var(--ink-2)', marginBottom: 28, maxWidth: 580, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.6 }}>
            Monitor reports what a policy would have blocked without blocking it, so you see the effect on real work first. Free for one developer.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 12 }}>
            <a href={SIGN_UP} className="btn btn-primary" style={{ padding: '13px 26px', fontSize: 15, display: 'inline-block' }}>Get started free</a>
            <a href={DEMO} className="btn btn-ghost" style={{ padding: '13px 22px', fontSize: 15, display: 'inline-block' }}>Book a demo</a>
            <Link href="/docs" className="btn btn-ghost" style={{ padding: '13px 22px', fontSize: 15, display: 'inline-block' }}>Read the docs</Link>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '8px 18px', marginTop: 28, fontSize: 13, color: 'var(--ink-3)' }}>
            {['Signed policies, enforced offline', 'Data hosted in the US', 'Encrypted in transit and at rest', 'Tamper-evident audit trail', 'No source code or prompts collected'].map((t) => (
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
