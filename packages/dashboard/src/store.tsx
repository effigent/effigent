'use client';

/**
 * Console state (demo). One client store shared by every page under the
 * shell, so an approval decided on the Overview is gone from /approvals and
 * the bell. Seeded from `data.ts`; when the control-plane API lands, these
 * reducers become optimistic updates in front of its calls.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { APPROVALS, EVENTS, LIST_ENTRIES, LIVE_STREAM, POLICIES } from './data.ts';
import type { Approval, ConsoleEvent, Env, ListEntry, Policy, PolicyRule } from './types.ts';

export type Range = '1h' | '24h' | '7d' | '30d';
export const RANGES: { id: Range; label: string }[] = [
  { id: '1h', label: 'Last hour' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
];

export interface Viewer { name: string; role: string; initials: string }

interface State {
  approvals: Approval[];
  policies: Policy[];
  lists: ListEntry[];
  events: ConsoleEvent[];
  env: Env | null;
  range: Range;
  viewer: Viewer;
  updatedSec: number; // seconds since the last live event (drives "Last updated")
  toast: string | null;
}

type Act =
  | { t: 'decide'; id: string; decision: 'approved' | 'approval_denied'; note?: string }
  | { t: 'policy'; id: string; patch: Partial<Policy> }
  | { t: 'addRule'; id: string; rule: PolicyRule }
  | { t: 'removeRule'; id: string; ruleId: string }
  | { t: 'addPolicy'; policy: Policy }
  | { t: 'addEntry'; entry: ListEntry }
  | { t: 'removeEntry'; id: string }
  | { t: 'env'; env: Env | null }
  | { t: 'range'; range: Range }
  | { t: 'viewer'; viewer: Viewer }
  | { t: 'live'; ev: ConsoleEvent }
  | { t: 'tick' }
  | { t: 'toast'; text: string | null };

function reducer(s: State, a: Act): State {
  switch (a.t) {
    case 'decide': {
      const ap = s.approvals.find((x) => x.id === a.id);
      if (!ap || ap.state !== 'approval_pending') return s;
      const approved = a.decision === 'approved';
      const ev: ConsoleEvent = {
        id: `ev-${a.id}`, time: 'now', ago: 'just now', type: 'approval', severity: 'medium',
        outcome: approved ? 'allowed' : 'blocked', title: approved ? 'Approval granted' : 'Approval denied',
        agentType: ap.agentType, user: ap.user, endpoint: ap.endpoint, env: ap.env,
        summary: `${approved ? 'approved' : 'denied'}: ${ap.title.toLowerCase()}`, target: ap.fingerprint,
      };
      return {
        ...s,
        approvals: s.approvals.map((x) =>
          x.id === a.id ? { ...x, state: a.decision, decidedBy: s.viewer.name, decidedAgo: 'just now', note: a.note || x.note } : x),
        events: [ev, ...s.events],
        toast: `${approved ? 'Approved' : 'Denied'} — ${ap.title}`,
      };
    }
    case 'policy':
      return { ...s, policies: s.policies.map((p) => (p.id === a.id ? { ...p, ...a.patch, version: p.version + 1, updatedAgo: 'just now' } : p)) };
    case 'addRule':
      return { ...s, policies: s.policies.map((p) => (p.id === a.id ? { ...p, rules: [...p.rules, a.rule], version: p.version + 1, updatedAgo: 'just now' } : p)) };
    case 'removeRule':
      return { ...s, policies: s.policies.map((p) => (p.id === a.id ? { ...p, rules: p.rules.filter((r) => r.id !== a.ruleId), version: p.version + 1, updatedAgo: 'just now' } : p)) };
    case 'addPolicy':
      return { ...s, policies: [...s.policies, a.policy] };
    case 'addEntry':
      return { ...s, lists: [a.entry, ...s.lists], toast: `Added ${a.entry.value} to the ${a.entry.list}list` };
    case 'removeEntry':
      return { ...s, lists: s.lists.filter((e) => e.id !== a.id) };
    case 'env':
      return { ...s, env: a.env };
    case 'range':
      return { ...s, range: a.range };
    case 'viewer':
      return { ...s, viewer: a.viewer };
    case 'live':
      return { ...s, events: [a.ev, ...s.events].slice(0, 60), updatedSec: 0 };
    case 'tick':
      return { ...s, updatedSec: s.updatedSec + 15 };
    case 'toast':
      return { ...s, toast: a.text };
  }
}

const initial: State = {
  approvals: APPROVALS,
  policies: POLICIES,
  lists: LIST_ENTRIES,
  events: EVENTS,
  env: null,
  range: '24h',
  viewer: { name: 'Jane Doe', role: 'Admin', initials: 'JD' },
  updatedSec: 120,
  toast: null,
};

interface Store extends State {
  dispatch: (a: Act) => void;
  pending: Approval[];
  decide: (id: string, decision: 'approved' | 'approval_denied', note?: string) => void;
  inEnv: (env: Env) => boolean;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [s, dispatch] = useReducer(reducer, initial);

  // Demo "live" feed: a new endpoint event every 15s while the console is open.
  useEffect(() => {
    let i = 0;
    const id = setInterval(() => {
      if (i < LIVE_STREAM.length * 3 && i % 2 === 1) {
        const base = LIVE_STREAM[Math.floor(i / 2) % LIVE_STREAM.length];
        const d = new Date();
        const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        dispatch({ t: 'live', ev: { ...base, id: `ev-live-${i}`, time, ago: 'just now' } });
      } else {
        dispatch({ t: 'tick' });
      }
      i++;
    }, 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!s.toast) return;
    const id = setTimeout(() => dispatch({ t: 'toast', text: null }), 3200);
    return () => clearTimeout(id);
  }, [s.toast]);

  const decide = useCallback(
    (id: string, decision: 'approved' | 'approval_denied', note?: string) => dispatch({ t: 'decide', id, decision, note }),
    [],
  );
  const value = useMemo<Store>(() => ({
    ...s,
    dispatch,
    decide,
    pending: s.approvals.filter((a) => a.state === 'approval_pending'),
    inEnv: (env: Env) => s.env === null || s.env === env,
  }), [s, decide]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStore outside <StoreProvider>');
  return v;
}

export function agoLabel(sec: number): string {
  if (sec < 30) return 'just now';
  if (sec < 90) return '1 min ago';
  return `${Math.round(sec / 60)} min ago`;
}
