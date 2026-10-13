/**
 * Light / Dark / System theme — the parts the server needs. The inline script
 * runs in <head> before first paint (app/layout.tsx) and sets
 * <html data-theme="light|dark"> from the stored choice, so there is no flash
 * of the wrong theme; theme.tsx keeps it in step afterwards.
 */
export const THEME_KEY = 'effigent.theme';
export type ThemePref = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem(${JSON.stringify(THEME_KEY)});var t=p==='light'||p==='dark'?p:(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');var d=document.documentElement;d.setAttribute('data-theme',t);d.style.colorScheme=t;}catch(e){}})();`;
