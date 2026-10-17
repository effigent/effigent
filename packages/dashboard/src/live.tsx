'use client';

/**
 * Live control-plane data for the console: who the server thinks you are
 * (/me), endpoints, the endpoint policy and its history, agent events and the
 * console audit trail. Fetched on mount and whenever the active Clerk org (=
 * tenant) changes; endpoints, events and policy are polled every 15s while the
 * tab is visible. Views read this through `useLive()`; features the control
 * plane does not serve yet (lists, identity) read `useStore()`; the agent
 * graph is built client-side from `events` (lib/live-graph.ts).
 *
 * Demo Mode (demo.tsx) swaps the real API for the in-memory fixture
 * (lib/fixture-api.ts): same routes, same views, sample data — and no request
 * ever leaves the browser, so nothing real can be published, enrolled or
 * revoked from the demo.
 */
import { useAuth } from '@clerk/nextjs';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ApiError, apiErrorText, canWrite as roleCanWrite, createApi, type Api, type ApiApproval, type ApiAuditEntry, type ApiEndpoint, type ApiEvent, type ApiMe, type ApiPolicyVersion,
} from '@/lib/api.ts';
import { createFixtureApi } from '@/lib/fixture-api.ts';
import { useDemoMode } from '@/demo.tsx';
import { ago, toConsoleEvent, toEndpointRow, type EndpointRow } from '@/lib/live-map.ts';
import type { ConsoleEvent } from '@/types.ts';

const POLL_MS = 15_000;
const EVENT_LIMIT = 500; // the API has no time filter; 500 feeds the agent graph and keeps a 15s poll small (server default 200, max 1000)
const AUDIT_LIMIT = 200;
/** What the agent graph is drawn from first: everything policy stopped or flagged in the last
 *  90 days (blocked, would block, approval waiting or denied, sensitive-file alerts), then the
 *  newest events. */
const PROBLEM_TYPES = 'blocked,would_block,approval_pending,approval_denied,file_open';
const PROBLEM_LIMIT = 1000;

interface Data {
  me: ApiMe | null;
  endpoints: ApiEndpoint[];
  events: ApiEvent[];
  problems: ApiEvent[];
  policy: ApiPolicyVersion | null;
  history: ApiPolicyVersion[];
  audit: ApiAuditEntry[];
  approvals: ApiApproval[];
}

const EMPTY: Data = { me: null, endpoints: [], events: [], problems: [], policy: null, history: [], audit: [], approvals: [] };

export interface Live extends Data {
  api: Api;
  /** true in Demo Mode: the in-memory sample fixture answers, not the real API */
  fixture: boolean;
  loaded: boolean; // the first full load finished (successfully or not)
  error: string | null; // the last refresh's failure, shown as a banner
  updatedAt: number | null;
  now: number; // advances with each poll so "x min ago" labels stay fresh
  canWrite: boolean;
  endpointRows: EndpointRow[];
  consoleEvents: ConsoleEvent[]; // newest first, `ago` filled in
  /** The agent graph's events: problems in the last 90 days plus the newest events, newest first. */
  graphEvents: ApiEvent[];
  consoleById: Map<number, ConsoleEvent>;
  latestPolicy: number; // newest published version (0 = none)
  pendingApprovals: number;
  /** Re-fetch everything now (after a write, or from a Retry button). */
  refresh: () => Promise<void>;
  /** Re-fetch only the approval requests (the Approvals page polls this). */
  refreshApprovals: () => Promise<void>;
}

const Ctx = createContext<Live | null>(null);

function LiveProvider({ api, scope, ready, fixture, children }: { api: Api; scope: string; ready: boolean; fixture: boolean; children: ReactNode }) {
  const [data, setData] = useState<Data>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const gen = useRef(0);

  // `full` also reloads the slow-moving resources (me, history, audit).
  const load = useCallback(async (full: boolean) => {
    const g = gen.current;
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const [me, endpoints, events, problems, policy, history, audit, approvals] = await Promise.allSettled([
      full ? api.get<ApiMe>('/me') : Promise.resolve(null),
      api.get<ApiEndpoint[]>('/endpoints'),
      api.get<ApiEvent[]>(`/events?limit=${EVENT_LIMIT}`),
      // an older control plane ignores paged=1 and answers with the newest events: fine either way
      api.get<{ events: ApiEvent[] } | ApiEvent[]>(`/events?paged=1&limit=${PROBLEM_LIMIT}&type=${PROBLEM_TYPES}&since=${since}`)
        .then((r) => (Array.isArray(r) ? r : r.events ?? [])),
      api.get<ApiPolicyVersion>('/policy'),
      full ? api.get<ApiPolicyVersion[]>('/policy/history') : Promise.resolve(null),
      full ? api.get<ApiAuditEntry[]>(`/audit?limit=${AUDIT_LIMIT}`) : Promise.resolve(null),
      // A control plane older than approvals answers 404: no approvals, not an error.
      api.get<ApiApproval[]>('/approvals?limit=200').catch((e) => (e instanceof ApiError && e.status === 404 ? [] : Promise.reject(e))),
    ]);
    if (g !== gen.current) return; // the tenant changed while this was in flight
    const val = <T,>(r: PromiseSettledResult<T | null>, prev: T): T => (r.status === 'fulfilled' && r.value !== null ? r.value : prev);
    setData((d) => ({
      me: val(me, d.me),
      endpoints: val(endpoints, d.endpoints),
      events: val(events, d.events),
      problems: val(problems, d.problems),
      policy: val(policy, d.policy),
      history: val(history, d.history),
      audit: val(audit, d.audit),
      approvals: val(approvals, d.approvals),
    }));
    const failed = [me, endpoints, events, problems, policy, history, audit, approvals].find((r): r is PromiseRejectedResult => r.status === 'rejected');
    setError(failed ? apiErrorText(failed.reason) : null);
    const t = Date.now();
    if (!failed) setUpdatedAt(t);
    setNow(t);
    setLoaded(true);
  }, [api]);

  // Tenant switch (or first mount): drop the previous tenant's data before
  // fetching, so nothing from org A is ever shown under org B.
  useEffect(() => {
    gen.current++;
    setData(EMPTY);
    setLoaded(false);
    setError(null);
    setUpdatedAt(null);
    // Until Clerk has loaded there is no token yet; asking now would flash a 401 banner.
    if (ready) void load(true);
  }, [scope, ready, load]);

  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load(false);
    }, POLL_MS);
    const onVis = () => { if (!document.hidden) void load(false); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [ready, load]);

  const refresh = useCallback(() => load(true), [load]);
  const refreshApprovals = useCallback(async () => {
    const g = gen.current;
    try {
      const approvals = await api.get<ApiApproval[]>('/approvals?limit=200');
      if (g === gen.current) setData((d) => ({ ...d, approvals }));
    } catch { /* the next full poll reports errors */ }
    if (g === gen.current) setNow(Date.now());
  }, [api]);

  const value = useMemo<Live>(() => {
    const endpointRows = data.endpoints.map((e) => toEndpointRow(e, now));
    const hostById = new Map(endpointRows.map((e) => [e.id, e.hostname]));
    const consoleEvents = data.events.map((e) => {
      const ce = toConsoleEvent(e, hostById);
      return { ...ce, ago: ago(ce.at ?? null, now) };
    });
    const consoleById = new Map(data.events.map((e, i) => [e.id, consoleEvents[i]]));
    const seen = new Set(data.events.map((e) => e.id));
    const extra = data.problems.filter((e) => !seen.has(e.id));
    for (const e of extra) {
      const ce = toConsoleEvent(e, hostById);
      consoleById.set(e.id, { ...ce, ago: ago(ce.at ?? null, now) });
    }
    const graphEvents = extra.length ? [...data.events, ...extra].sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || b.id - a.id) : data.events;
    return {
      ...data, api, fixture, loaded, error, updatedAt, now, refresh, refreshApprovals,
      canWrite: roleCanWrite(data.me?.role),
      endpointRows, consoleEvents, graphEvents, consoleById,
      latestPolicy: data.policy?.version ?? 0,
      pendingApprovals: data.approvals.filter((a) => a.state === 'pending' && Date.parse(a.expires_at) > now).length,
    };
  }, [data, api, fixture, loaded, error, updatedAt, now, refresh, refreshApprovals]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Real API: Clerk session token per request; the active org is the tenant.
 *  `gate` holds every request until Demo Mode has been read from storage. */
function ClerkLiveProvider({ gate, children }: { gate: boolean; children: ReactNode }) {
  const { getToken, orgId, userId, isLoaded, isSignedIn } = useAuth();
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const api = useMemo(() => createApi(() => tokenRef.current()), []);
  return <LiveProvider api={api} scope={`${userId ?? ''}/${orgId ?? 'personal'}`} ready={gate && isLoaded && !!isSignedIn} fixture={false}>{children}</LiveProvider>;
}

/** Demo Mode: a fresh sample workspace each time it is switched on. */
function FixtureLiveProvider({ children }: { children: ReactNode }) {
  const api = useMemo(() => createFixtureApi(), []);
  return <LiveProvider api={api} scope="demo" ready fixture>{children}</LiveProvider>;
}

const NO_CONTROL_PLANE = 'There is no control plane in this dev build (auth is bypassed) — turn on Demo Mode to try this on sample data.';

/** Dev auth bypass with Demo Mode off: there is no Clerk session to call the
 *  real API with, so reads come back empty (the honest empty states) and
 *  writes are refused. */
const devEmptyApi: Api = {
  get<T>(path: string): Promise<T> {
    const p = path.split('?')[0];
    if (p === '/endpoints' || p === '/events' || p === '/policy/history' || p === '/audit' || p === '/approvals' || p === '/api-keys' || p === '/webhooks') return Promise.resolve([] as T);
    if (p === '/me' || p === '/policy') return Promise.resolve(null as T);
    if (p === '/exceptions') return Promise.resolve([] as T);
    if (p === '/approval-routing') return Promise.resolve({ groups: [], routes: [], default_group: '' } as T);
    if (p === '/events/archives') return Promise.resolve({ retention_days: 90, archive_enabled: false, archives: [] } as T);
    if (p === '/exceptions/options') return Promise.resolve({ options: [], agents: [], mode: '' } as T);
    return Promise.reject(new ApiError(503, NO_CONTROL_PLANE));
  },
  send: () => Promise.reject(new ApiError(503, NO_CONTROL_PLANE)),
};

/** Dev bypass against a local control plane: its admin token and a tenant
 *  (`EFFIGENT_ADMIN_TENANTS` on the control plane, `EFFIGENT_CONSOLE_ORIGIN`
 *  = this dev server). Dead code in production builds, like the bypass. */
const DEV_ADMIN = process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_EFFIGENT_DEV_ADMIN_TOKEN && process.env.NEXT_PUBLIC_EFFIGENT_DEV_TENANT
  ? { token: process.env.NEXT_PUBLIC_EFFIGENT_DEV_ADMIN_TOKEN, tenant: process.env.NEXT_PUBLIC_EFFIGENT_DEV_TENANT }
  : null;

function DevAdminLiveProvider({ ready, children }: { ready: boolean; children: ReactNode }) {
  const api = useMemo(() => createApi(async () => DEV_ADMIN!.token, { 'X-Effigent-Tenant': DEV_ADMIN!.tenant }), []);
  return <LiveProvider api={api} scope={`dev/${DEV_ADMIN!.tenant}`} ready={ready} fixture={false}>{children}</LiveProvider>;
}

export function LiveDataProvider({ dev, children }: { dev: boolean; children: ReactNode }) {
  const { demo, ready } = useDemoMode();
  if (demo) return <FixtureLiveProvider>{children}</FixtureLiveProvider>;
  if (dev && DEV_ADMIN) return <DevAdminLiveProvider ready={ready}>{children}</DevAdminLiveProvider>;
  if (dev) return <LiveProvider api={devEmptyApi} scope="dev" ready={ready} fixture={false}>{children}</LiveProvider>;
  return <ClerkLiveProvider gate={ready}>{children}</ClerkLiveProvider>;
}

export function useLive(): Live {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLive outside <LiveDataProvider>');
  return v;
}

/** Range filter for live events (the API has no time filter; we filter the fetched window). */
export const RANGE_MS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000 } as const;
