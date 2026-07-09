import { useState, useEffect } from 'react';

const KEY = 'effigent-theme';

/** Light/dark toggle — persists to localStorage; a pre-hydration script in the
 *  layout applies the saved value before first paint (no flash). */
export function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const saved = (localStorage.getItem(KEY) as 'dark' | 'light' | null) ?? 'dark';
    setTheme(saved);
  }, []);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem(KEY, next);
  };

  return (
    <button className="theme-toggle" onClick={toggle} title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} aria-label="Toggle theme">
      {theme === 'dark' ? (
        // sun
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        // moon
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
