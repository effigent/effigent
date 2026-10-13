'use client';

import { useEffect, useRef, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { RANGES, useStore } from '@/store.tsx';

export function RangeSelect() {
  const { range, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="bell-wrap" ref={box}>
      <button className="select-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <Ic n="calendar" size={16} />
        <span>{RANGES.find((r) => r.id === range)!.label}</span>
        <Ic n="chevronDown" size={15} />
      </button>
      {open && (
        <div className="pop range-pop" role="listbox">
          {RANGES.map((r) => (
            <button key={r.id} role="option" aria-selected={r.id === range} className={`pop-opt ${r.id === range ? 'on' : ''}`}
              onClick={() => { dispatch({ t: 'range', range: r.id }); setOpen(false); }}>
              {r.label} {r.id === range && <Ic n="check" size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
