/**
 * Deployment endpoints — env-driven, never hardcoded domains.
 * NEXT_PUBLIC_* vars are inlined at build time:
 *  - site (static export): set in the GitHub Action build step
 *  - local: .env.local
 * When unset, snippets show an explicit placeholder instead of a fake domain.
 */
export const COLLECTOR_URL = process.env.NEXT_PUBLIC_COLLECTOR_URL || 'https://ccopt-dashboard-wyvz.vercel.app';
export const DASHBOARD_URL = process.env.NEXT_PUBLIC_DASHBOARD_URL || 'https://ccopt-dashboard-wyvz.vercel.app';
export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL || 'sales@your-domain';
export const TRACES_URL = `${COLLECTOR_URL}/v1/traces`;
