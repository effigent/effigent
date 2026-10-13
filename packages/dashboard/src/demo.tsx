'use client';

/**
 * Demo Mode: a per-browser switch that swaps the whole console onto the
 * sample workspace (data.ts + the in-memory fixture API) so a prospect can see
 * what a full workspace looks like. Off by default — then the console shows
 * only what the control plane serves, and features without a backend show an
 * honest empty state.
 *
 * Persisted in localStorage (every access wrapped: private windows and blocked
 * storage throw). Read through useSyncExternalStore so server render and
 * hydration both see "off" without a mismatch, then the stored value takes
 * over; the `storage` event keeps other tabs in step.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';

const KEY = 'effigent.demoMode';
const listeners = new Set<() => void>();

function read(): boolean {
  try { return window.localStorage.getItem(KEY) === '1'; } catch { return false; }
}

// Fallback when localStorage cannot be written, so the switch still flips for this page view.
let memory: boolean | null = null;

function write(on: boolean) {
  try {
    if (on) window.localStorage.setItem(KEY, '1');
    else window.localStorage.removeItem(KEY);
    memory = null;
  } catch {
    memory = on;
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY || e.key === null) { memory = null; cb(); } };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(cb); window.removeEventListener('storage', onStorage); };
}

const snapshot = () => memory ?? read();

interface DemoMode {
  /** Showing the sample workspace instead of the control plane. */
  demo: boolean;
  /** False during server render and hydration; nothing may fetch until it is true. */
  ready: boolean;
  setDemo: (on: boolean) => void;
}

const Ctx = createContext<DemoMode | null>(null);

export function DemoModeProvider({ children }: { children: ReactNode }) {
  const demo = useSyncExternalStore(subscribe, snapshot, () => false);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const setDemo = useCallback((on: boolean) => write(on), []);
  const value = useMemo(() => ({ demo: ready && demo, ready, setDemo }), [demo, ready, setDemo]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDemoMode(): DemoMode {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDemoMode outside <DemoModeProvider>');
  return v;
}
