'use client';

/**
 * Live control-plane data for the console: who the server thinks you are
 * (/me), endpoints, the endpoint policy and its history, agent events and the
 * console audit trail. Fetched on mount and whenever the active Clerk org (=
 * tenant) changes; endpoints, events and policy are polled every 15s while the
 * tab is visible. Views read this through `useLive()`; demo-only features
 * (approvals, lists, identity, graph) still read `useStore()`.
 */
import { useAuth } from '@clerk/nextjs';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  apiErrorText, canWrite as roleCanWrite, createApi, type Api, type ApiAuditEntry, type ApiEndpoint, type ApiEvent, type ApiMe, type ApiPolicyVersion,
} from '@/lib/api.ts';
import { createFixtureApi } from '@/lib/fixture-api.ts';
import { ago, toConsoleEvent, toEndpointRow, type EndpointRow } from '@/lib/live-map.ts';
import type { ConsoleEvent } from '@/types.ts';

const POLL_MS = 15_000;
const EVENT_LIMIT = 300; // the API has no time filter; 300 keeps a 15s poll small (server default 200, max 1000)
const AUDIT_LIMIT = 200;

interface Data {
  me: ApiMe | null;
  endpoints: ApiEndpoint[];
  events: ApiEvent[];
  policy: ApiPolicyVersion | null;
  history: ApiPolicyVersion[];
  audit: ApiAuditEntry[];
}

const EMPTY: Data = { me: null, endpoints: [], events: [], policy: null, history: [], audit: [] };

export interface Live extends Data {
  api: Api;
  /** true while running on the in-memory dev fixture (auth bypass), not the real API */
  fixture: boolean;
  loaded: boolean; // the first full load finished (successfully or not)
  error: string | null; // the last refresh's failure, shown as a banner
  updatedAt: number | null;
  now: number; // advances with each poll so "x min ago" labels stay fresh
  canWrite: boolean;
  endpointRows: EndpointRow[];
  consoleEvents: ConsoleEvent[]; // newest first, `ago` filled in
  latestPolicy: number; // newest published version (0 = none)
  /** Re-fetch everything now (after a write, or from a Retry button). */
  refresh: () => Promise<void>;
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
    const [me, endpoints, events, policy, history, audit] = await Promise.allSettled([
      full ? api.get<ApiMe>('/me') : Promise.resolve(null),
      api.get<ApiEndpoint[]>('/endpoints'),
      api.get<ApiEvent[]>(`/events?limit=${EVENT_LIMIT}`),
      api.get<ApiPolicyVersion>('/policy'),
      full ? api.get<ApiPolicyVersion[]>('/policy/history') : Promise.resolve(null),
      full ? api.get<ApiAuditEntry[]>(`/audit?limit=${AUDIT_LIMIT}`) : Promise.resolve(null),
    ]);
    if (g !== gen.current) return; // the tenant changed while this was in flight
    const val = <T,>(r: PromiseSettledResult<T | null>, prev: T): T => (r.status === 'fulfilled' && r.value !== null ? r.value : prev);
    setData((d) => ({
      me: val(me, d.me),
      endpoints: val(endpoints, d.endpoints),
      events: val(events, d.events),
      policy: val(policy, d.policy),
      history: val(history, d.history),
      audit: val(audit, d.audit),
    }));
    const failed = [me, endpoints, events, policy, history, audit].find((r): r is PromiseRejectedResult => r.status === 'rejected');
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

  const value = useMemo<Live>(() => {
    const endpointRows = data.endpoints.map((e) => toEndpointRow(e, now));
    const hostById = new Map(endpointRows.map((e) => [e.id, e.hostname]));
    const consoleEvents = data.events.map((e) => {
      const ce = toConsoleEvent(e, hostById);
      return { ...ce, ago: ago(ce.at ?? null, now) };
    });
    return {
      ...data, api, fixture, loaded, error, updatedAt, now, refresh,
      canWrite: roleCanWrite(data.me?.role),
      endpointRows, consoleEvents,
      latestPolicy: data.policy?.version ?? 0,
    };
  }, [data, api, fixture, loaded, error, updatedAt, now, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Real API: Clerk session token per request; the active org is the tenant. */
function ClerkLiveProvider({ children }: { children: ReactNode }) {
  const { getToken, orgId, userId, isLoaded, isSignedIn } = useAuth();
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const api = useMemo(() => createApi(() => tokenRef.current()), []);
  return <LiveProvider api={api} scope={`${userId ?? ''}/${orgId ?? 'personal'}`} ready={isLoaded && !!isSignedIn} fixture={false}>{children}</LiveProvider>;
}

/** Dev auth bypass: there is no Clerk (useAuth would throw), so serve the fixture. */
function FixtureLiveProvider({ children }: { children: ReactNode }) {
  const api = useMemo(() => createFixtureApi(), []);
  return <LiveProvider api={api} scope="dev" ready fixture>{children}</LiveProvider>;
}

export function LiveDataProvider({ dev, children }: { dev: boolean; children: ReactNode }) {
  return dev ? <FixtureLiveProvider>{children}</FixtureLiveProvider> : <ClerkLiveProvider>{children}</ClerkLiveProvider>;
}

export function useLive(): Live {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLive outside <LiveDataProvider>');
  return v;
}

/** Range filter for live events (the API has no time filter; we filter the fetched window). */
export const RANGE_MS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;
