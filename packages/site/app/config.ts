/**
 * Deployment endpoints — env-driven, never hardcoded in pages.
 * NEXT_PUBLIC_* vars are inlined at build time:
 *  - site (static export): set in the GitHub Action build step
 *  - local: .env.local
 * The fallbacks below are only used when a var is unset at build time.
 */
// Endpoints (effigentd) talk to the control-plane API; humans use the console.
// The env var keeps its historical name so the deploy workflow needs no change.
export const COLLECTOR_URL = process.env.NEXT_PUBLIC_COLLECTOR_URL || 'https://api.effigent.ai';
export const API_URL = COLLECTOR_URL;
export const DASHBOARD_URL = process.env.NEXT_PUBLIC_DASHBOARD_URL || 'https://app.effigent.ai';
export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL || 'sales@effigent.ai';
// Security questions, documents under NDA and vulnerability reports.
export const SECURITY_EMAIL = process.env.NEXT_PUBLIC_SECURITY_EMAIL || 'security@effigent.ai';
