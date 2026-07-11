/**
 * Deployment endpoints — env-driven, never hardcoded domains.
 * NEXT_PUBLIC_* vars are inlined at build time:
 *  - site (static export): set in the GitHub Action build step
 *  - local: .env.local
 * When unset, snippets show an explicit placeholder instead of a fake domain.
 */
// Agents send captured runs to the collector; humans browse the dashboard. Kept
// as separate subdomains so ingestion can move to its own infra later (DNS-only).
export const COLLECTOR_URL = process.env.NEXT_PUBLIC_COLLECTOR_URL || 'https://collector.effigent.ai';
export const DASHBOARD_URL = process.env.NEXT_PUBLIC_DASHBOARD_URL || 'https://app.effigent.ai';
export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL || 'sales@your-domain';
export const TRACES_URL = `${COLLECTOR_URL}/v1/traces`;
