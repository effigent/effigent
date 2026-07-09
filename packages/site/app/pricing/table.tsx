'use client';

import { useState } from 'react';
import { DASHBOARD_URL, CONTACT_EMAIL } from '../config';

interface Tier {
  name: string;
  monthly: number | null; // null = custom
  annual: number | null;
  tagline: string;
  agents: string;
  storage: string;
  features: string[];
  cta: string;
  href: string;
  highlight?: boolean;
}

const TIERS: Tier[] = [
  {
    name: 'Free',
    monthly: 0,
    annual: 0,
    tagline: 'Kick the tires on a couple of agents.',
    agents: '2 agents',
    storage: '1 GB stored data',
    features: ['All capture methods', 'Execution graphs & cost', 'Determinism insights', 'Community support'],
    cta: 'Start free',
    href: `${DASHBOARD_URL}/sign-up`,
  },
  {
    name: 'Starter',
    monthly: 15,
    annual: 150,
    tagline: 'For a small fleet in production.',
    agents: '5 agents',
    storage: '20 GB stored data',
    features: ['Everything in Free', 'Session-level cost breakdown', 'Optimization action items', 'Email support'],
    cta: 'Get started',
    href: `${DASHBOARD_URL}/sign-up`,
  },
  {
    name: 'Pro',
    monthly: 80,
    annual: 800,
    tagline: 'Serious agent fleets, serious savings.',
    agents: '20 agents',
    storage: '100 GB stored data',
    features: ['Everything in Starter', 'Multi-workspace organizations', 'Advanced determinism window', 'Priority support'],
    cta: 'Go Pro',
    href: `${DASHBOARD_URL}/sign-up`,
    highlight: true,
  },
  {
    name: 'Enterprise',
    monthly: null,
    annual: null,
    tagline: 'Your scale, your controls.',
    agents: 'Unlimited agents',
    storage: 'Custom storage & retention',
    features: ['Everything in Pro', 'SSO / SAML', 'Self-hosted collector option', 'Custom DPA & SLA', 'Dedicated support'],
    cta: 'Talk to us',
    href: `mailto:${CONTACT_EMAIL}?subject=Effigent%20Enterprise`,
  },
];

export function PricingTable() {
  const [annual, setAnnual] = useState(true);

  return (
    <div>
      {/* billing toggle */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 36 }}>
        <div style={{ display: 'inline-flex', border: '1px solid var(--line-2)', borderRadius: 22, padding: 4, background: 'oklch(0.995 0.002 90)' }}>
          {(['Monthly', 'Annual'] as const).map((label) => {
            const on = (label === 'Annual') === annual;
            return (
              <button
                key={label}
                onClick={() => setAnnual(label === 'Annual')}
                className="btn"
                style={{
                  padding: '8px 20px', fontSize: 13.5, borderRadius: 18,
                  background: on ? 'var(--ink)' : 'transparent',
                  color: on ? 'var(--cream)' : 'var(--ink-3)',
                  boxShadow: 'none', transform: 'none',
                }}
              >
                {label}{label === 'Annual' && <span style={{ marginLeft: 7, fontSize: 11, opacity: 0.75 }}>2 months free</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* tier cards */}
      <div className="pricing-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, alignItems: 'stretch' }}>
        {TIERS.map((t) => (
          <div
            key={t.name}
            className="tier-card"
            style={{
              display: 'flex', flexDirection: 'column', borderRadius: 14, padding: '26px 24px',
              border: t.highlight ? '2px solid var(--ink)' : '1px solid var(--line)',
              background: 'oklch(0.995 0.002 90)', position: 'relative',
            }}
          >
            {t.highlight && (
              <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', background: 'var(--ink)', color: 'var(--cream)', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', borderRadius: 12, padding: '4px 12px', whiteSpace: 'nowrap' }}>
                Most popular
              </div>
            )}
            <div style={{ fontSize: 16, fontWeight: 700 }}>{t.name}</div>
            <div style={{ fontSize: 13, color: 'var(--ink-3)', margin: '4px 0 18px', minHeight: 34 }}>{t.tagline}</div>

            <div style={{ marginBottom: 18 }}>
              {t.monthly === null ? (
                <div className="h-serif" style={{ fontSize: 30, lineHeight: 1 }}>Custom</div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span className="h-serif" style={{ fontSize: 38, lineHeight: 1 }}>
                    ${annual ? t.annual : t.monthly}
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>{t.monthly === 0 ? 'forever' : annual ? '/ year' : '/ month'}</span>
                </div>
              )}
              {t.monthly !== null && t.monthly > 0 && annual && (
                <div style={{ fontSize: 12, color: 'var(--green)', marginTop: 6, fontWeight: 600 }}>
                  ${Math.round((t.annual as number) / 12)} / month, billed annually
                </div>
              )}
            </div>

            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginBottom: 18 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>{t.agents}</div>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>{t.storage}</div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 24 }}>
              {t.features.map((f) => (
                <div key={f} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 13, color: 'var(--ink-2)' }}>
                  <span style={{ color: 'var(--green)', fontWeight: 700, lineHeight: 1.4 }}>✓</span> {f}
                </div>
              ))}
            </div>

            <a
              href={t.href}
              className={`btn ${t.highlight ? 'btn-primary' : 'btn-ghost'}`}
              style={{ marginTop: 'auto', padding: '11px 0', fontSize: 14, textAlign: 'center', display: 'block' }}
            >
              {t.cta}
            </a>
          </div>
        ))}
      </div>

      <div style={{ textAlign: 'center', marginTop: 28, fontSize: 13, color: 'var(--ink-3)' }}>
        Data stored = compressed transcripts, execution graphs and analysis. Every plan includes redaction, scoped keys and all harnesses.
      </div>
    </div>
  );
}
