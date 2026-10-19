/**
 * Demo Mode's Pricing Leaks: a sample workspace with the same JSON shapes as
 * GET /api/v1/pricing-leaks (spend.Report) and its writes, in memory only.
 * People and machines match the sample fleet in data.ts.
 */
import { ApiError, type ApiLeak, type ApiPricingLeaks, type ApiSpendConnector, type ApiSpendImport, type ApiSpendSettings, type ApiSpendVendor } from './api.ts';

const VENDORS: ApiSpendVendor[] = ['cursor', 'anthropic', 'copilot', 'openai'];
const LABEL: Record<string, string> = {
  cursor: 'Cursor', anthropic: 'Anthropic (Claude Code)', copilot: 'GitHub Copilot', openai: 'OpenAI (Codex)',
  google: 'Google (Gemini CLI)', byok: 'Bring-your-own-key agents',
};
const DEFAULT_PRICES = {
  seat: { cursor: 4000, copilot: 1900, 'copilot/business': 1900, 'copilot/enterprise': 3900, anthropic: 0, openai: 0 },
  personal: { cursor: 2000, anthropic: 2000, openai: 2000, copilot: 1000, google: 0, byok: 0 },
};
const at = (p: string) => `${p}@acme.example`;

const LEAKS: ApiLeak[] = [
  { id: 'runaway_cost:anthropic:raj.patel@acme.example', type: 'runaway_cost', vendor: 'anthropic', person: at('raj.patel'), name: 'Raj Patel',
    title: 'Anthropic (Claude Code) spend 12× the team median', confidence: 'high', monthly_savings_cents: 89_500, at_risk_cents: 0,
    evidence: ['$1,180 in the last 30 days; team median $95 across 9 people', 'Spike on {d2}: $412 vs a $31/day average the week before (claude-code)',
      'effigentd: claude-code on raj-ws on 29 of the last 30 days, including runs between 01:00 and 05:00', 'Savings = spend above 3× the median'] },
  { id: 'runaway_cost:anthropic:apikey:ci-nightly', type: 'runaway_cost', vendor: 'anthropic', person: 'apikey:ci-nightly',
    title: 'Anthropic (Claude Code) cost spike', confidence: 'medium', monthly_savings_cents: 17_200, at_risk_cents: 0,
    evidence: ['Spike on {d1}: $184 vs a $12/day average the week before (claude-code)', 'API key “ci-nightly” isn\'t linked to a person; ci-runner-03 runs it',
      'Often an agent looping (e.g. in CI); savings = the spend above the usual daily level'] },
  { id: 'unused_seat:cursor:emma.brooks@acme.example', type: 'unused_seat', vendor: 'cursor', person: at('emma.brooks'), name: 'Emma Brooks',
    title: 'Unused Cursor seat', confidence: 'high', monthly_savings_cents: 4000, at_risk_cents: 0,
    evidence: ['Cursor reports no activity for this seat', 'effigentd: no Cursor agent on emma-mba in 30 days', 'Seat: $40/month (member)'] },
  { id: 'unused_seat:cursor:tom.weiss@acme.example', type: 'unused_seat', vendor: 'cursor', person: at('tom.weiss'), name: 'Tom Weiss',
    title: 'Unused Cursor seat', confidence: 'high', monthly_savings_cents: 4000, at_risk_cents: 0,
    evidence: ['Cursor: last activity {d47} (47 days ago)', 'effigentd: no Cursor agent on ci-runner-03, ops-runner-02 in 30 days', 'Seat: $40/month (member)'] },
  { id: 'unused_seat:cursor:noa.levi@acme.example', type: 'unused_seat', vendor: 'cursor', person: at('noa.levi'), name: 'Noa Levi',
    title: 'Unused Cursor seat', confidence: 'high', monthly_savings_cents: 4000, at_risk_cents: 0,
    evidence: ['Cursor reports no activity for this seat', 'effigentd: no Cursor agent on noa-mbp in 30 days', 'Seat: $40/month (member)'] },
  { id: 'duplicate_tool:cursor:sarah.lee@acme.example', type: 'duplicate_tool', vendor: 'cursor', person: at('sarah.lee'), name: 'Sarah Lee',
    title: 'Pays for Cursor, works in Anthropic (Claude Code)', confidence: 'high', monthly_savings_cents: 4000, at_risk_cents: 0,
    evidence: ['Anthropic (Claude Code) used on 24 of the last 30 days (claude-code)', 'Cursor used on 1 days (cursor-agent)', 'Dropping the Cursor seat saves $40/month'] },
  { id: 'unused_seat:copilot:dan.cohen@acme.example', type: 'unused_seat', vendor: 'copilot', person: at('dan.cohen'), name: 'Dan Cohen',
    title: 'Unused GitHub Copilot seat', confidence: 'high', monthly_savings_cents: 1900, at_risk_cents: 0,
    evidence: ['GitHub Copilot: last activity {d63} (63 days ago)', 'effigentd: no GitHub Copilot agent on dan-dev-vm in 30 days', 'Seat: $19/month (business)'] },
  { id: 'unused_seat:copilot:lena.kim@acme.example', type: 'unused_seat', vendor: 'copilot', person: at('lena.kim'), name: 'Lena Kim',
    title: 'Unused GitHub Copilot seat', confidence: 'medium', monthly_savings_cents: 1900, at_risk_cents: 0,
    evidence: ['GitHub Copilot reports no activity for this seat', 'effigentd: no enrolled machine is linked to this person (set a machine owner or a People alias)', 'Seat: $19/month (business)'] },
  { id: 'duplicate_tool:copilot:alex.wang@acme.example', type: 'duplicate_tool', vendor: 'copilot', person: at('alex.wang'), name: 'Alex Wang',
    title: 'Pays for GitHub Copilot, works in Cursor', confidence: 'high', monthly_savings_cents: 1900, at_risk_cents: 0,
    evidence: ['Cursor used on 22 of the last 30 days (cursor-agent)', 'GitHub Copilot used on 2 days', 'Dropping the GitHub Copilot seat saves $19/month'] },
  { id: 'shadow_spend:openai:mike.tan@acme.example', type: 'shadow_spend', vendor: 'openai', person: at('mike.tan'), name: 'Mike Tan',
    title: 'OpenAI (Codex) used off the company plan', confidence: 'high', monthly_savings_cents: 0, at_risk_cents: 2000,
    evidence: ['effigentd saw codex on 17 of the last 30 days on mike-mbp', 'OpenAI (Codex) has no seat or usage for this person on the company account',
      'If they use a shared company API key, add the key name to their People aliases', 'Likely a personal plan (from $20/month) paid or expensed outside the company plan'] },
  { id: 'shadow_spend:anthropic:omar.haddad@acme.example', type: 'shadow_spend', vendor: 'anthropic', person: at('omar.haddad'), name: 'Omar Haddad',
    title: 'Anthropic (Claude Code) used off the company plan', confidence: 'medium', monthly_savings_cents: 0, at_risk_cents: 2000,
    evidence: ['effigentd saw claude-code on 6 of the last 30 days on prod-bastion-01', 'Anthropic (Claude Code) has no seat or usage for this person on the company account',
      'If they use a shared company API key, add the key name to their People aliases', 'Likely a personal plan (from $20/month) paid or expensed outside the company plan'] },
  { id: 'shadow_spend:google:mike.tan@acme.example', type: 'shadow_spend', vendor: 'google', person: at('mike.tan'), name: 'Mike Tan',
    title: 'Google (Gemini CLI) used off the company plan', confidence: 'low', monthly_savings_cents: 0, at_risk_cents: 0,
    evidence: ['effigentd saw gemini-cli on 4 of the last 30 days on mike-mbp', 'No company Gemini plan is connected: this runs on a personal Google account or API key'] },
  { id: 'shadow_spend:byok:priya.shah@acme.example', type: 'shadow_spend', vendor: 'byok', person: at('priya.shah'), name: 'Priya Shah',
    title: 'Bring-your-own-key agents used off the company plan', confidence: 'low', monthly_savings_cents: 0, at_risk_cents: 0,
    evidence: ['effigentd saw aider, opencode on 9 of the last 30 days on priya-mba', 'Open-source agent on a model API key that isn\'t on a connected company account'] },
];

const PEOPLE: ApiSpendSettings['people'] = [
  { email: at('jane.doe'), name: 'Jane Doe', aliases: ['jane-mbp', 'github:janedoe'] },
  { email: at('alex.wang'), name: 'Alex Wang', aliases: ['github:awang-dev'] },
  { email: at('sarah.lee'), name: 'Sarah Lee', aliases: ['github:sarahlee'] },
  { email: at('raj.patel'), name: 'Raj Patel', aliases: ['raj-ws', 'anthropic:raj-laptop-key'] },
  { email: at('dan.cohen'), name: 'Dan Cohen', aliases: ['github:dcohen'] },
  { email: at('lena.kim'), name: 'Lena Kim', aliases: ['github:lenakim'] },
];

export function createPricingLeaksFixture(now: number) {
  const day = (ago: number) => new Date(now - ago * 86_400_000).toISOString().slice(0, 10);
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const leaks = LEAKS.map((l) => ({ ...l, evidence: l.evidence.map((e) => e.replace(/\{d(\d+)\}/g, (_, n) => day(Number(n)))) }));
  let connectors: ApiSpendConnector[] = [
    { vendor: 'cursor', label: LABEL.cursor, configured: true, key_hint: 'f3a9', settings: {}, sync_status: 'ok', last_sync_at: iso(60 * 5),
      last_counts: { seats: 14, usage_rows: 236 }, updated_by: 'user_demo', csv_seats: 0, csv_usage_rows: 0 },
    { vendor: 'anthropic', label: LABEL.anthropic, configured: true, key_hint: '7QzA', settings: {}, sync_status: 'ok', last_sync_at: iso(60 * 5),
      last_counts: { seats: 12, usage_rows: 311 }, updated_by: 'user_demo', csv_seats: 0, csv_usage_rows: 0 },
    { vendor: 'copilot', label: LABEL.copilot, configured: true, key_hint: 'x2Lk', settings: { org: 'acme' }, sync_status: 'ok', last_sync_at: iso(60 * 5),
      last_counts: { seats: 11, usage_rows: 0 }, updated_by: 'user_demo', csv_seats: 0, csv_usage_rows: 0 },
    { vendor: 'openai', label: LABEL.openai, configured: false, settings: {}, sync_status: '', csv_seats: 0, csv_usage_rows: 64 },
  ];
  let settings: ApiSpendSettings = { people: PEOPLE, prices: { seat: {}, personal: {} }, updated_by: 'user_demo', updated_at: iso(60 * 24 * 2) };

  const report = (): ApiPricingLeaks['report'] => {
    const on = new Set(connectors.filter((c) => c.configured || c.csv_seats || c.csv_usage_rows).map((c) => c.vendor as string));
    const ls = leaks.filter((l) => on.has(l.vendor) || l.vendor === 'google' || l.vendor === 'byok');
    const vendors = [
      { vendor: 'cursor', label: LABEL.cursor, seats: 14, active_seats: 10, seat_cents: 56_000, usage_cents: 21_240, monthly_cents: 77_240, connected: on.has('cursor') },
      { vendor: 'anthropic', label: LABEL.anthropic, seats: 12, active_seats: 11, seat_cents: 0, usage_cents: 214_060, monthly_cents: 214_060, connected: on.has('anthropic') },
      { vendor: 'copilot', label: LABEL.copilot, seats: 11, active_seats: 7, seat_cents: 20_900, usage_cents: 0, monthly_cents: 20_900, connected: on.has('copilot') },
      { vendor: 'openai', label: LABEL.openai, seats: 0, active_seats: 0, seat_cents: 0, usage_cents: 38_610, monthly_cents: 38_610, estimated: true, connected: on.has('openai') },
    ].filter((v) => v.connected);
    return {
      generated_at: new Date().toISOString(), window_days: 30, vendors,
      total_monthly_cents: vendors.reduce((s, v) => s + v.monthly_cents, 0),
      leaks: ls, total_savings_cents: ls.reduce((s, l) => s + l.monthly_savings_cents, 0), total_at_risk_cents: ls.reduce((s, l) => s + l.at_risk_cents, 0),
      people: [], unattributed: ['ci-runner-03'],
    };
  };
  const page = (): ApiPricingLeaks => ({ report: report(), connectors, settings, default_prices: DEFAULT_PRICES, secrets_available: true });
  const setConn = (v: string, f: (c: ApiSpendConnector) => ApiSpendConnector) => { connectors = connectors.map((c) => (c.vendor === v ? f(c) : c)); };

  return {
    get(path: string): ApiPricingLeaks | undefined {
      return path === '/pricing-leaks' ? page() : undefined;
    },
    /** undefined = not a Pricing Leaks route */
    send(method: string, path: string, body: unknown): unknown | ApiError | undefined {
      const b = (body ?? {}) as Record<string, unknown>;
      const conn = path.match(/^\/pricing-leaks\/connectors\/([a-z]+)$/);
      if (conn) {
        const v = conn[1];
        if (!VENDORS.includes(v as ApiSpendVendor)) return new ApiError(404, 'unknown vendor (cursor, anthropic, copilot, openai)');
        if (method === 'DELETE') { setConn(v, (c) => ({ ...c, configured: false, key_hint: undefined, sync_status: '', last_sync_at: undefined, last_counts: undefined })); return { ok: true }; }
        const key = String(b.key ?? '').trim();
        const org = String(b.org ?? '').trim();
        if (key.length < 8) return new ApiError(400, 'paste the admin API key');
        if (v === 'copilot' && !org && !connectors.find((c) => c.vendor === v)?.settings.org) return new ApiError(400, 'set the GitHub organisation (its login, e.g. acme)');
        setConn(v, (c) => ({ ...c, configured: true, key_hint: key.slice(-4), settings: v === 'copilot' ? { org: org || c.settings.org } : c.settings,
          sync_status: 'ok', last_sync_at: new Date().toISOString(), last_error: undefined, last_counts: c.last_counts ?? { seats: 0, usage_rows: 0 } }));
        return { vendor: v, configured: true, key_hint: key.slice(-4), sync_started: true };
      }
      if (method === 'POST' && path === '/pricing-leaks/sync') {
        const started = connectors.filter((c) => c.configured).map((c) => c.vendor);
        if (!started.length) return new ApiError(400, 'no vendor is connected; add an admin API key first');
        connectors = connectors.map((c) => (c.configured ? { ...c, last_sync_at: new Date().toISOString(), sync_status: 'ok' } : c));
        return { started, already_running: [] };
      }
      if (method === 'POST' && path === '/pricing-leaks/import') {
        const v = String(b.vendor ?? ''); const kind = b.kind === 'seats' ? 'seats' : 'usage';
        const lines = String(b.csv ?? '').split(/\r?\n/).filter((l) => l.trim()).length - 1;
        if (!VENDORS.includes(v as ApiSpendVendor)) return new ApiError(400, 'unknown vendor (cursor, anthropic, copilot, openai)');
        if (lines < 1) return new ApiError(400, 'no usable rows in the file');
        setConn(v, (c) => (kind === 'seats' ? { ...c, csv_seats: lines } : { ...c, csv_usage_rows: lines }));
        const r: ApiSpendImport = { vendor: v, kind, rows: lines, seats: kind === 'seats' ? lines : 0, usage_rows: kind === 'usage' ? lines : 0, skipped: 0 };
        return r;
      }
      const clear = path.match(/^\/pricing-leaks\/import\/([a-z]+)$/);
      if (method === 'DELETE' && clear) { setConn(clear[1], (c) => ({ ...c, csv_seats: 0, csv_usage_rows: 0 })); return { ok: true }; }
      if (method === 'PUT' && path === '/pricing-leaks/settings') {
        const s = b as unknown as ApiSpendSettings;
        settings = { people: s.people ?? [], prices: { seat: s.prices?.seat ?? {}, personal: s.prices?.personal ?? {} }, updated_by: 'user_demo', updated_at: new Date().toISOString() };
        return settings;
      }
      return undefined;
    },
  };
}
