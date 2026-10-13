'use client';

/**
 * Client UI state shared by every page under the shell: the time range, the
 * environment filter, the toast, the signed-in viewer — plus the features the
 * control plane does not serve yet (approvals, multi-policy rules, allow/deny
 * lists), which stay on the demo dataset in `data.ts`. Everything the API does
 * serve (endpoints, events, the endpoint policy, the audit trail) lives in
 * `live.tsx`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { APPROVALS, LIST_ENTRIES, POLICIES } from './data.ts';
import type { Approval, Env, ListEntry, Policy, PolicyRule } from './types.ts';

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
  env: Env | null;
  range: Range;
  viewer: Viewer;
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
  | { t: 'toast'; text: string | null };

function reducer(s: State, a: Act): State {
  switch (a.t) {
    case 'decide': {
      const ap = s.approvals.find((x) => x.id === a.id);
      if (!ap || ap.state !== 'approval_pending') return s;
      const approved = a.decision === 'approved';
      return {
        ...s,
        approvals: s.approvals.map((x) =>
          x.id === a.id ? { ...x, state: a.decision, decidedBy: s.viewer.name, decidedAgo: 'just now', note: a.note || x.note } : x),
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
    case 'toast':
      return { ...s, toast: a.text };
  }
}

const initial: State = {
  approvals: APPROVALS,
  policies: POLICIES,
  lists: LIST_ENTRIES,
  env: null,
  range: '24h',
  viewer: { name: 'Jane Doe', role: 'Admin', initials: 'JD' },
  toast: null,
};

interface Store extends State {
  dispatch: (a: Act) => void;
  pending: Approval[];
  decide: (id: string, decision: 'approved' | 'approval_denied', note?: string) => void;
  /** Demo rows carry an environment; control-plane data has none, so it always passes. */
  inEnv: (env: Env | null) => boolean;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [s, dispatch] = useReducer(reducer, initial);

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
    inEnv: (env: Env | null) => env === null || s.env === null || s.env === env,
  }), [s, decide]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStore outside <StoreProvider>');
  return v;
}
