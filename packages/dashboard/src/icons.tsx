/** Minimal inline stroke-icon set (Lucide-style), no external dependency. */
import type { CSSProperties } from 'react';

const P: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
  activity: 'M3 12h4l3 8 4-16 3 8h4',
  route: 'M6 19a3 3 0 1 0 0-6h9a3 3 0 1 0 0-6M6 19V7M18 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM6 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
  gauge: 'M12 14l4-4M4 20a8 8 0 1 1 16 0',
  dollar: 'M12 2v20M17 6a4 4 0 0 0-4-3H11a3 3 0 0 0 0 6h2a3 3 0 0 1 0 6h-1a4 4 0 0 1-4-3',
  box: 'M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10c1 1 1 2 1 3h6c0-1 0-2 1-3a6 6 0 0 0-4-10Z',
  scale: 'M12 3v18M7 21h10M6 7h12M6 7 3 14h6L6 7ZM18 7l-3 7h6l-3-7Z',
  wrench: 'M14.5 5.5a3.5 3.5 0 0 0-4.9 4.4L4 15.5 8.5 20l5.6-5.6a3.5 3.5 0 0 0 4.4-4.9l-2.3 2.3-2.1-2.1 2.3-2.3Z',
  database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3ZM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  layers: 'M12 3 3 8l9 5 9-5-9-5ZM3 13l9 5 9-5',
  filter: 'M3 5h18l-7 8v6l-4-2v-4L3 5Z',
  graph: 'M5 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM19 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM7 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM6 6l11 1M7 14l5-5',
  map: 'M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3ZM9 3v15M15 6v15',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  shield: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z',
  rotate: 'M3 12a9 9 0 1 0 3-6.7M3 4v4h4',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  lock: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z',
  calendar: 'M7 3v4M17 3v4M4 8h16M5 5h14v16H5zM4 8v13h16V8',
  spark: 'M12 3l1.8 4.7L18.5 9l-4.7 1.3L12 15l-1.8-4.7L5.5 9l4.7-1.3L12 3ZM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  cpu: 'M6 6h12v12H6zM9 9h6v6H9M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3',
  scissors: 'M6 6a2.5 2.5 0 1 0 0-.01M6 18a2.5 2.5 0 1 0 0-.01M8 8l12 8M8 16l12-8',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4',
  check: 'M4 12l5 5L20 6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  x: 'M6 6l12 12M18 6 6 18',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4.5-6.5',
  tag: 'M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9ZM7.5 7.5h.01',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  percent: 'M19 5 5 19M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12ZM8.5 12h.01M12 12h.01M15.5 12h.01',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4',
  loop: 'M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9',
  terminal: 'M4 17l6-5-6-5M12 19h8',
};

export function Ic({ n, className, style }: { n: string; className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden="true">
      <path d={P[n] ?? P.box} />
    </svg>
  );
}
