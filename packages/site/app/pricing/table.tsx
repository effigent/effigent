'use client';

import { useState } from 'react';
import { DASHBOARD_URL, CONTACT_EMAIL } from '../config';

interface Tier {
  name: string;
  monthly: number | null; // null = custom
  annual: number | null;
  tagline: string;
  seats: string;
  endpoints: string;
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
    tagline: 'One developer, a couple of machines.',
    seats: '1 seat',
    endpoints: '2 endpoints',
    features: ['Agent graph & events', 'Allow / deny policies', 'Monitor and learn modes', '7-day audit history', 'Community support'],
    cta: 'Start free',
    href: `${DASHBOARD_URL}/sign-up`,
  },
  {
    name: 'Starter',
    monthly: 15,
    annual: 150,
    tagline: 'A small team trying policies on real work.',
    seats: '5 seats',
    endpoints: '10 endpoints',
    features: ['Everything in Free', 'Require-approval rules', 'Emergency suspend', '30-day audit history', 'Email support'],
    cta: 'Get started',
    href: `${DASHBOARD_URL}/sign-up`,
  },
  {
    name: 'Pro',
    monthly: 80,
    annual: 800,
    tagline: 'Teams enforcing policy across machines.',
    seats: '20 seats',
    endpoints: '40 endpoints',
    features: ['Everything in Starter', 'Team-scoped policies & reviewers', 'Pricing Leaks: AI seat and spend findings', 'Policy simulation', '1-year audit history & export', 'Priority support'],
    cta: 'Go Pro',
    href: `${DASHBOARD_URL}/sign-up`,
    highlight: true,
  },
  {
    name: 'Enterprise',
    monthly: null,
    annual: null,
    tagline: 'Your scale, your controls.',
    seats: 'Custom seats',
    endpoints: 'Custom endpoints',
    features: ['Everything in Pro', 'SSO / SAML', 'Self-hosted control plane', 'Audit export to your SIEM', 'Custom retention, DPA & SLA', 'Dedicated support'],
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
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>{t.seats}</div>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>{t.endpoints}</div>
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
        A seat is a person in the console or an owner of enrolled machines. An endpoint is one machine running effigentd. Every plan covers Linux, macOS, Windows and Kubernetes, and every agent effigentd recognises.
      </div>
    </div>
  );
}
