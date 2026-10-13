/** Minimal inline stroke-icon set (Lucide-style), no external dependency. */
import type { CSSProperties } from 'react';

const P: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
  activity: 'M3 12h4l3 8 4-16 3 8h4',
  graph: 'M5 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM19 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM7 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM6 6l11 1M7 14l5-5',
  network: 'M12 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM5 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 9v3M12 12l-5.5 3.5M12 12l5.5 3.5',
  shield: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z',
  shieldCheck: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3ZM9 12l2 2 4-4',
  listCheck: 'M11 6h10M11 12h10M11 18h10M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3.5 17l3 3M6.5 17l-3 3',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  idcard: 'M3 5h18v14H3zM7 10a2 2 0 1 0 4 0 2 2 0 0 0-4 0M5.5 16a3.5 3.5 0 0 1 7 0M14 9h4M14 13h4',
  clipboard: 'M9 3h6v3H9zM9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3M8 12h8M8 16h5',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4.5-6.5',
  github: 'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4M9 18c-4.51 2-5-2-7-2',
  slack: 'M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5zM20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5zM3.5 14H5v1.5c0 .83-.67 1.5-1.5 1.5S2 16.33 2 15.5 2.67 14 3.5 14zM14 14.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5zM15.5 19H14v1.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zM10 9.5C10 8.67 9.33 8 8.5 8h-5C2.67 8 2 8.67 2 9.5S2.67 11 3.5 11h5c.83 0 1.5-.67 1.5-1.5zM8.5 5H10V3.5C10 2.67 9.33 2 8.5 2S7 2.67 7 3.5 7.67 5 8.5 5z',
  database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3ZM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  terminal: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
  globe: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z',
  key: 'M15.5 7.5 19 4M21 2l-2 2 3 3-3.5 3.5-3-3M11.4 11.6a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78ZM11.4 11.6 15.5 7.5',
  package: 'M21 16V8l-9-5-9 5v8l9 5 9-5ZM3.3 7 12 12l8.7-5M12 22V12M7.5 4.5l9 5',
  burst: 'M12 2v20M2 12h20M5 5l14 14M19 5 5 19',
  cube: 'M21 16V8l-9-5-9 5v8l9 5 9-5ZM3.3 7 12 12l8.7-5M12 22V12',
  hex: 'M12 2l8.66 5v10L12 22l-8.66-5V7L12 2ZM12 8l3.46 2v4L12 16l-3.46-2v-4L12 8Z',
  spark: 'M12 3l1.8 4.7L18.5 9l-4.7 1.3L12 15l-1.8-4.7L5.5 9l4.7-1.3L12 3ZM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  feather: 'M20.2 4.8a6 6 0 0 0-8.5 0L5 11.5V19h7.5l6.7-6.7a6 6 0 0 0 1-7.5ZM16 8 2 22M17.5 15H9',
  ban: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM4.9 4.9l14.2 14.2',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 6v6l4 2',
  calendar: 'M7 3v4M17 3v4M4 8h16M5 5h14v16H5zM4 8v13h16V8',
  check: 'M4 12l5 5L20 6',
  checkCircle: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM8 12l3 3 5-6',
  x: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  collapse: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  more: 'M12 5h.01M12 12h.01M12 19h.01',
  menu: 'M4 7h16M4 12h16M4 17h16',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  filter: 'M3 5h18l-7 8v6l-4-2v-4L3 5Z',
  server: 'M4 3h16v8H4zM4 13h16v8H4zM8 7h.01M8 17h.01',
  laptop: 'M4 5h16v10H4zM2 19h20',
  cloud: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z',
  hook: 'M18 4a3 3 0 1 0-3 3M15 7v6a5 5 0 0 1-10 0v-2M5 11l-2 2M5 11l2 2',
  cpu: 'M6 6h12v12H6zM9 9h6v6H9M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3',
  lock: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  rotate: 'M3 12a9 9 0 1 0 3-6.7M3 4v4h4',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8ZM12 18v4',
  layers: 'M12 3 3 8l9 5 9-5-9-5ZM3 13l9 5 9-5',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z',
  external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
};

export function Ic({ n, className, style, size }: { n: string; className?: string; style?: CSSProperties; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"
      style={size ? { width: size, height: size, ...style } : style}>
      <path d={P[n] ?? P.cube} />
    </svg>
  );
}

/** The Effigent mark (the "E" whose middle bar is an arrow) — drawn as SVG so it
 *  stays crisp on the dark shell; mirrors public/icon_effigent.png. */
export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <defs>
        <linearGradient id="eff-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#4f7cff" />
        </linearGradient>
      </defs>
      <path d="M38 9H17a9 9 0 0 0-9 9M38 39H17a9 9 0 0 1-9-9" fill="none" stroke="url(#eff-g)" strokeWidth="6" strokeLinecap="round" />
      <path d="M8 24h26" stroke="url(#eff-g)" strokeWidth="6" strokeLinecap="round" />
      <path d="M31 17.5 38.5 24 31 30.5" fill="none" stroke="url(#eff-g)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
