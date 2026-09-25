import { useMemo, useState } from 'react';
import { buildRunMap, type MapLoop, type MapNode } from '@/lib/engine/runmap.ts';
import type { Run } from '@/lib/engine/types.ts';

/**
 * The run map — the whole session as a network (engine/runmap.ts). Nodes are the
 * distinct steps (size = visits); edges are the order the run moved between them;
 * loops — local cycles the run went round again and again — light up:
 *   yellow = a recurring cycle or exploration loop · blue = an edit → check fix loop ·
 *   red = a loop where ≥20% of visits failed. Hover a step to see its neighbourhood;
 *   pick a loop in the list to isolate it.
 */

const LOOP_COLOR: Record<MapLoop['kind'], string> = { cycle: '#facc15', explore: '#facc15', fix: '#60a5fa', error: '#fb7185' };
const LOOP_LABEL: Record<MapLoop['kind'], string> = { cycle: 'recurring cycle', explore: 'exploration loop', fix: 'fix loop (edit ⇄ check)', error: 'loop with failures' };
const GLYPH: Record<MapNode['kind'], string> = {
  explore: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  edit: 'M4 20h4L19 9l-4-4L4 16v4Z',
  verify: 'M4 12l5 5L20 6',
  deliver: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  delegate: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9',
  other: 'M4 17l6-5-6-5M12 19h8',
};

const W = 1000, H = 640, PAD = 36;

export function RunMap({ run }: { run: Run }) {
  const map = useMemo(() => buildRunMap(run), [run]);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  if (map.nodes.length < 3) return null;

  const pos = new Map(map.nodes.map((n) => [n.id, { x: PAD + n.x * (W - 2 * PAD), y: PAD + n.y * (H - 2 * PAD) }]));
  const maxV = Math.max(...map.nodes.map((n) => n.visits));
  const size = (n: MapNode) => (n.hub ? 30 : 12 + 16 * Math.sqrt(n.visits / maxV));
  const neighbours = new Set<string>();
  if (hover) for (const e of map.edges) { if (e.from === hover) neighbours.add(e.to); if (e.to === hover) neighbours.add(e.from); }
  const lit = (n: MapNode) => (focus != null ? n.loop === focus : hover ? n.id === hover || neighbours.has(n.id) : true);
  const color = (n: MapNode) => (n.loop >= 0 ? LOOP_COLOR[map.loops[n.loop].kind] : '#8b93a7');
  const hn = hover ? map.nodes.find((n) => n.id === hover) : null;

  return (
    <div className="runmap">
      <div className="runmap-head">
        <div>
          <div className="runmap-title">Run map</div>
          <div className="runmap-sub">
            {map.steps.toLocaleString()} tool calls over {map.nodes.length} distinct steps · {Math.round((100 * map.revisits) / Math.max(1, map.steps))}% of calls went back to a step already visited
            {map.folded > 0 && ` · ${map.folded} rare calls grouped as "other"`}
          </div>
        </div>
        <div className="runmap-legend">
          <span><i style={{ background: '#8b93a7' }} />step</span>
          <span><i style={{ background: LOOP_COLOR.cycle }} />recurring loop</span>
          <span><i style={{ background: LOOP_COLOR.fix }} />fix loop</span>
          <span><i style={{ background: LOOP_COLOR.error }} />loop with failures</span>
        </div>
      </div>
      <div className="runmap-body">
        <div className="runmap-canvas">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Network of the steps this session took and the loops it went round">
            <defs>
              <marker id="rm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 Z" fill="#5b6478" />
              </marker>
            </defs>
            {map.edges.map((e) => {
              const a = pos.get(e.from)!, b = pos.get(e.to)!;
              if (e.from === e.to) return null;
              const on = focus != null ? e.loop === focus : hover ? e.from === hover || e.to === hover : true;
              const c = e.loop >= 0 ? LOOP_COLOR[map.loops[e.loop].kind] : '#5b6478';
              return (
                <line key={`${e.from}→${e.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={c}
                  strokeOpacity={on ? (e.loop >= 0 ? 0.85 : 0.35) : 0.06} strokeWidth={Math.min(4, 0.8 + Math.log2(1 + e.count) * 0.6)}
                  markerEnd={on && e.count > 1 ? 'url(#rm-arrow)' : undefined} />
              );
            })}
            {map.nodes.map((n) => {
              const p = pos.get(n.id)!, s = size(n), c = color(n), on = lit(n);
              const selfLoop = map.edges.find((e) => e.from === n.id && e.to === n.id);
              return (
                <g key={n.id} transform={`translate(${p.x - s / 2},${p.y - s / 2})`} opacity={on ? 1 : 0.18}
                  onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} style={{ cursor: 'pointer' }}>
                  <title>{`${n.label} — ${n.visits} visits${n.errors ? `, ${n.errors} failed` : ''}, $${n.costUsd.toFixed(2)}`}</title>
                  {selfLoop && selfLoop.count >= 2 && <circle cx={s} cy={0} r={s * 0.28} fill="none" stroke={c} strokeWidth="1.5" strokeOpacity="0.8" />}
                  <rect width={s} height={s} rx={s * 0.22} fill={n.loop >= 0 ? c : '#3a4256'} stroke={n.loop >= 0 ? c : '#5b6478'} strokeOpacity="0.9" fillOpacity={n.loop >= 0 ? 0.92 : 1} />
                  <g transform={`translate(${s * 0.22},${s * 0.22}) scale(${(s * 0.56) / 24})`}>
                    <path d={GLYPH[n.kind]} fill="none" stroke={n.loop >= 0 ? '#0b1020' : '#c7ccd8'} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </g>
                  {n.errors >= 2 && n.errors >= 0.2 * n.visits && <path d={`M${s - 2},${-6} l6,10 h-12 z`} fill="#fb7185" stroke="#0b1020" strokeWidth="1" />}
                  {(n.hub || (hover === n.id)) && (
                    <text x={s / 2} y={s + 14} textAnchor="middle" fontSize="11.5" fontWeight="600" fill="#e2e6f0" stroke="#10141f" strokeWidth="3" paintOrder="stroke" style={{ pointerEvents: 'none' }}>{n.label.slice(0, 26)}</text>
                  )}
                </g>
              );
            })}
          </svg>
          {hn && (
            <div className="runmap-tip">
              <b>{hn.label}</b>
              <span>{hn.visits} visits · ${hn.costUsd.toFixed(2)}{hn.errors ? ` · ${hn.errors} failed` : ''}</span>
              {hn.loop >= 0 && <span style={{ color: LOOP_COLOR[map.loops[hn.loop].kind] }}>part of loop {hn.loop + 1}: {LOOP_LABEL[map.loops[hn.loop].kind]}</span>}
            </div>
          )}
        </div>
        <aside className="runmap-loops" aria-label="Loops in this session">
          <div className="runmap-loops-head">Loops the run kept returning to</div>
          {map.loops.length === 0 && <div className="runmap-empty">No step was returned to three or more times in a short span.</div>}
          {map.loops.map((l) => (
            <button type="button" key={l.index} className={`runmap-loop ${focus === l.index ? 'on' : ''}`}
              onClick={() => setFocus(focus === l.index ? null : l.index)} aria-pressed={focus === l.index}>
              <span className="runmap-loop-dot" style={{ background: LOOP_COLOR[l.kind] }} />
              <span className="runmap-loop-main">
                <span className="runmap-loop-label">{l.label}</span>
                <span className="runmap-loop-meta">{LOOP_LABEL[l.kind]} · {l.passes} passes · ${l.costUsd.toFixed(2)}{l.errors ? ` · ${l.errors} failed` : ''}</span>
              </span>
            </button>
          ))}
        </aside>
      </div>
    </div>
  );
}
