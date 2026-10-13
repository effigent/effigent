'use client';

/**
 * The console theme: Light, Dark or System (default — follows the OS
 * prefers-color-scheme and its changes). Stored per browser in localStorage
 * (every access wrapped: private windows and blocked storage throw); the
 * inline script in app/layout.tsx applies it before first paint. Read through
 * useSyncExternalStore so server render and hydration see "system / dark"
 * without a mismatch, then the real value takes over.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { THEME_KEY, type Theme, type ThemePref } from '@/lib/theme-script.ts';

export type { Theme, ThemePref };

const listeners = new Set<() => void>();
let memory: ThemePref | null = null; // when localStorage can't be written

function readPref(): ThemePref {
  if (memory) return memory;
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch { return 'system'; }
}

const MQ = '(prefers-color-scheme: light)';
function resolve(p: ThemePref): Theme {
  if (p !== 'system') return p;
  try { return window.matchMedia(MQ).matches ? 'light' : 'dark'; } catch { return 'dark'; }
}

function apply() {
  const t = resolve(readPref());
  const d = document.documentElement;
  if (d.getAttribute('data-theme') !== t) d.setAttribute('data-theme', t);
  d.style.colorScheme = t;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onChange = () => { apply(); cb(); };
  const onStorage = (e: StorageEvent) => { if (e.key === THEME_KEY || e.key === null) { memory = null; onChange(); } };
  let mq: MediaQueryList | null = null;
  try { mq = window.matchMedia(MQ); mq.addEventListener('change', onChange); } catch { /* old browser */ }
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(cb); mq?.removeEventListener('change', onChange); window.removeEventListener('storage', onStorage); };
}

const snapshot = () => `${readPref()}|${resolve(readPref())}`;

export function setThemePref(p: ThemePref) {
  try {
    if (p === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, p);
    memory = null;
  } catch { memory = p; }
  apply();
  listeners.forEach((l) => l());
}

/** The stored choice and the theme actually shown. */
export function useTheme(): { pref: ThemePref; theme: Theme; setPref: (p: ThemePref) => void } {
  const snap = useSyncExternalStore(subscribe, snapshot, () => 'system|dark');
  const [pref, theme] = snap.split('|') as [ThemePref, Theme];
  const setPref = useCallback((p: ThemePref) => setThemePref(p), []);
  return { pref, theme, setPref };
}

export const THEME_OPTIONS: { id: ThemePref; label: string }[] = [
  { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }, { id: 'system', label: 'System' },
];
