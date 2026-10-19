'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLive } from '@/live.tsx';
import { HELP } from '@/lib/help.tsx';
import { ApiError, apiErrorText, type ApiSpendMetrics } from '@/lib/api.ts';
import { Card, CardHead, Empty, Loading, Seg } from '@/components/ui.tsx';

/** Vendors in their fixed colour order (theme.css --viz-1…6): colour follows the vendor, never its rank. */
const ORDER = ['cursor', 'anthropic', 'copilot', 'openai', 'google', 'byok'];
const LABEL: Record<string, string> = {
  cursor: 'Cursor', anthropic: 'Anthropic', copilot: 'GitHub Copilot', openai: 'OpenAI', google: 'Google (Gemini)', byok: 'Bring-your-own-key',
};
const colorOf = (v: string) => (ORDER.includes(v) ? `var(--viz-${ORDER.indexOf(v) + 1})` : 'var(--txt-4)');
const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

type Range = '30' | '90' | '180';
type Measure = 'cost' | 'machines';

/** Pricing Leaks → Spend over time: what each vendor billed per day (stacked bars: costs add up), how many
 *  machines ran each vendor's agents (lines: a machine can run several), and the report's own history. */
export function SpendTrend() {
  const { api } = useLive();
  const [range, setRange] = useState<Range>('90');
  const [measure, setMeasure] = useState<Measure>('cost');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [data, setData] = useState<ApiSpendMetrics | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.get<ApiSpendMetrics>(`/pricing-leaks/metrics?days=${range}`)
      .then((d) => { if (live) { setData(d); setErr(null); } })
      .catch((e) => { if (live) setErr(e instanceof ApiError && e.status === 404 ? 'The control plane does not serve spend history yet — it needs to be updated.' : apiErrorText(e)); });
    return () => { live = false; };
  }, [api, range]);

  const series = useMemo(() => (data ? build(data, Number(range)) : null), [data, range]);
  const values = series ? (measure === 'cost' ? series.cost : series.machines) : null;
  const fmt = measure === 'cost' ? usd : (n: number) => `${n} machine${n === 1 ? '' : 's'}`;

  return (
    <Card>
      <CardHead info={HELP.spendTrend} title="Spend over time"
        sub={measure === 'cost' ? 'What each vendor billed per day: usage from their APIs or CSV exports (seats are monthly, in the table above).' : 'Machines where effigentd saw each vendor’s agents, per day.'}>
        <Seg value={measure} onChange={setMeasure} options={[{ id: 'cost', label: 'Cost' }, { id: 'machines', label: 'Agents' }]} />
        <Seg value={range} onChange={setRange} options={[{ id: '30', label: '30 d' }, { id: '90', label: '90 d' }, { id: '180', label: '180 d' }]} />
        <Seg value={view} onChange={setView} options={[{ id: 'chart', label: 'Chart' }, { id: 'table', label: 'Table' }]} />
      </CardHead>
      {err && <div className="callout bad" style={{ margin: '0 20px 16px' }}><span>{err}</span></div>}
      {!series ? (!err && <Loading />) : series.vendors[measure].length === 0 ? (
        <Empty icon="database" title={measure === 'cost' ? 'No daily usage yet' : 'No agent activity yet'}
          sub={measure === 'cost' ? 'Usage appears after a vendor sync or a usage CSV import. Seat-only vendors (Copilot) have no daily cost.' : 'Agents appear as effigentd reports them from enrolled machines.'} />
      ) : (
        <div style={{ padding: '0 20px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Legend vendors={series.vendors[measure]} totals={series.totals[measure]} fmt={measure === 'cost' ? usd : (n) => `${n} max/day`} />
          {view === 'chart'
            ? (measure === 'cost'
              ? <StackedBars days={series.days} vendors={series.vendors.cost} values={values!} fmt={usd} />
              : <Lines days={series.days} vendors={series.vendors.machines} values={values!} fmt={fmt} />)
            : <DayTable days={series.days} vendors={series.vendors[measure]} values={values!} fmt={measure === 'cost' ? usd : String} total={measure === 'cost'} />}
          <History data={data!} />
        </div>
      )}
    </Card>
  );
}

type Grid = Record<string, Record<string, number>>; // day -> vendor -> value

function build(m: ApiSpendMetrics, n: number) {
  const to = m.to.slice(0, 10);
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) days.push(new Date(Date.parse(`${to}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10));
  const cost: Grid = {}; const machines: Grid = {};
  const seen = { cost: new Set<string>(), machines: new Set<string>() };
  for (const u of m.usage) {
    const d = u.day.slice(0, 10);
    if (!u.cost_cents) continue;
    (cost[d] ??= {})[u.vendor] = (cost[d][u.vendor] ?? 0) + u.cost_cents;
    seen.cost.add(u.vendor);
  }
  for (const a of m.activity) {
    const d = a.day.slice(0, 10);
    (machines[d] ??= {})[a.vendor] = a.machines;
    seen.machines.add(a.vendor);
  }
  const order = (s: Set<string>) => [...ORDER.filter((v) => s.has(v)), ...[...s].filter((v) => !ORDER.includes(v)).sort()];
  const vendors = { cost: order(seen.cost), machines: order(seen.machines) };
  const totals = {
    cost: Object.fromEntries(vendors.cost.map((v) => [v, days.reduce((s, d) => s + (cost[d]?.[v] ?? 0), 0)])),
    machines: Object.fromEntries(vendors.machines.map((v) => [v, Math.max(0, ...days.map((d) => machines[d]?.[v] ?? 0))])),
  };
  return { days, cost, machines, vendors, totals };
}

function Legend({ vendors, totals, fmt }: { vendors: string[]; totals: Record<string, number>; fmt: (n: number) => string }) {
  return (
    <div className="viz-legend">
      {vendors.map((v) => <span key={v}><span className="sw" style={{ background: colorOf(v) }} />{LABEL[v] ?? v} <b style={{ color: 'var(--txt)' }}>{fmt(totals[v] ?? 0)}</b></span>)}
    </div>
  );
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** A round axis maximum: 1, 2, 2.5 or 5 × 10^k. */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

const H = 180, PAD_L = 52, PAD_B = 22, PAD_T = 8, PAD_R = 8;

function Frame({ width, max, fmt, days, children }: { width: number; max: number; fmt: (n: number) => string; days: string[]; children: ReactNode }) {
  const plotH = H - PAD_B - PAD_T;
  const plotW = width - PAD_L - PAD_R;
  const ticks = [0, max / 2, max];
  const xi = [0, Math.floor((days.length - 1) / 2), days.length - 1];
  return (
    <>
      {ticks.map((t) => {
        const y = PAD_T + plotH - (t / max) * plotH;
        return (
          <g key={t}>
            <line x1={PAD_L} x2={width - PAD_R} y1={y} y2={y} stroke="var(--border-soft)" strokeWidth={1} />
            <text className="viz-axis" x={PAD_L - 8} y={y + 4} textAnchor="end">{fmt(t)}</text>
          </g>
        );
      })}
      {xi.map((i, k) => (
        <text key={k} className="viz-axis" x={PAD_L + ((i + 0.5) * plotW) / days.length} y={H - 6} textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}>{dayLabel(days[i])}</text>
      ))}
      {children}
    </>
  );
}

/** A bar whose top (the data end) is rounded and whose base sits on the baseline. */
function topRounded(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function Readout({ day, vendors, row, fmt, total }: { day: string | null; vendors: string[]; row: Record<string, number> | undefined; fmt: (n: number) => string; total?: boolean }) {
  if (!day) return <div className="viz-readout">Hover a day for its breakdown.</div>;
  const parts = vendors.filter((v) => row?.[v]).map((v) => <span key={v}> · {LABEL[v] ?? v} <b>{fmt(row![v])}</b></span>);
  const sum = vendors.reduce((s, v) => s + (row?.[v] ?? 0), 0);
  return (
    <div className="viz-readout"><b>{dayLabel(day)}</b>{parts.length ? parts : <span> · nothing</span>}{total && parts.length > 1 && <span> · total <b>{fmt(sum)}</b></span>}</div>
  );
}

function StackedBars({ days, vendors, values, fmt }: { days: string[]; vendors: string[]; values: Grid; fmt: (n: number) => string }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...days.map((d) => vendors.reduce((s, v) => s + (values[d]?.[v] ?? 0), 0))));
  const plotH = H - PAD_B - PAD_T;
  const slot = (width - PAD_L - PAD_R) / days.length;
  const barW = Math.max(1, slot - 2);
  return (
    <div ref={ref} onMouseLeave={() => setHover(null)}>
      <Readout day={hover === null ? null : days[hover]} vendors={vendors} row={hover === null ? undefined : values[days[hover]]} fmt={fmt} total />
      <svg width={width} height={H} role="img" aria-label="Daily cost by vendor (stacked bars)">
        <Frame width={width} max={max} fmt={fmt} days={days}>
          {hover !== null && <rect x={PAD_L + hover * slot} y={PAD_T} width={slot} height={plotH} fill="var(--panel-3)" />}
          {days.map((d, i) => {
            let base = PAD_T + plotH;
            const segs = vendors.filter((v) => (values[d]?.[v] ?? 0) > 0);
            return (
              <g key={d}>
                {segs.map((v, k) => {
                  const h = ((values[d][v]) / max) * plotH;
                  const gap = k > 0 && h > 3 ? 2 : 0; // 2px surface gap between stacked segments
                  const y = base - h;
                  const x = PAD_L + i * slot + (slot - barW) / 2;
                  const el = k === segs.length - 1
                    ? <path key={v} d={topRounded(x, y, barW, h - gap, 4)} fill={colorOf(v)} />
                    : <rect key={v} x={x} y={y} width={barW} height={Math.max(0, h - gap)} fill={colorOf(v)} />;
                  base = y;
                  return el;
                })}
                <rect x={PAD_L + i * slot} y={PAD_T} width={slot} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
        </Frame>
      </svg>
    </div>
  );
}

function Lines({ days, vendors, values, fmt }: { days: string[]; vendors: string[]; values: Grid; fmt: (n: number) => string }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(1, ...days.flatMap((d) => vendors.map((v) => values[d]?.[v] ?? 0))));
  const plotH = H - PAD_B - PAD_T;
  const slot = (width - PAD_L - PAD_R) / days.length;
  const x = (i: number) => PAD_L + (i + 0.5) * slot;
  const y = (n: number) => PAD_T + plotH - (n / max) * plotH;
  return (
    <div ref={ref} onMouseLeave={() => setHover(null)}>
      <Readout day={hover === null ? null : days[hover]} vendors={vendors} row={hover === null ? undefined : values[days[hover]]} fmt={fmt} />
      <svg width={width} height={H} role="img" aria-label="Machines running each vendor's agents per day (lines)">
        <Frame width={width} max={max} fmt={(n) => String(Math.round(n))} days={days}>
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={PAD_T + plotH} stroke="var(--txt-4)" strokeWidth={1} />}
          {vendors.map((v) => (
            <polyline key={v} fill="none" stroke={colorOf(v)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
              points={days.map((d, i) => `${x(i)},${y(values[d]?.[v] ?? 0)}`).join(' ')} />
          ))}
          {hover !== null && vendors.map((v) => (
            <circle key={v} cx={x(hover)} cy={y(values[days[hover]]?.[v] ?? 0)} r={4} fill={colorOf(v)} stroke="var(--panel)" strokeWidth={2} />
          ))}
          {days.map((d, i) => <rect key={d} x={PAD_L + i * slot} y={PAD_T} width={slot} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />)}
        </Frame>
      </svg>
    </div>
  );
}

function DayTable({ days, vendors, values, fmt, total }: { days: string[]; vendors: string[]; values: Grid; fmt: (n: number) => string; total: boolean }) {
  const rows = [...days].reverse().filter((d) => vendors.some((v) => values[d]?.[v]));
  return (
    <div className="tbl-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
      <table className="tbl">
        <thead><tr><th>Day</th>{vendors.map((v) => <th key={v} className="num">{LABEL[v] ?? v}</th>)}{total && <th className="num">Total</th>}</tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d}>
              <td className="tnum">{d}</td>
              {vendors.map((v) => <td key={v} className="num tnum">{values[d]?.[v] ? fmt(values[d][v]) : '—'}</td>)}
              {total && <td className="num tnum"><b>{fmt(vendors.reduce((s, v) => s + (values[d]?.[v] ?? 0), 0))}</b></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function sumByDay<T extends { day: string }>(rows: T[], val: (r: T) => number): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.day.slice(0, 10), (m.get(r.day.slice(0, 10)) ?? 0) + val(r));
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** The report's own history (recorded daily since the first rollup): monthly spend and potential savings. */
function History({ data }: { data: ApiSpendMetrics }) {
  const spend = sumByDay(data.report, (r) => r.monthly_cents);
  const savings = sumByDay(data.leaks, (r) => r.savings_cents);
  if (spend.length < 2) {
    return <div className="muted" style={{ fontSize: 12.5 }}>The report is recorded once a day{spend.length ? ` (first: ${dayLabel(spend[0][0])})` : ''}; spend and savings trends appear from the second day.</div>;
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
      <Spark title="AI tool spend / month" points={spend} />
      <Spark title="Potential savings / month" points={savings.length ? savings : spend.map(([d]) => [d, 0] as [string, number])} />
    </div>
  );
}

function Spark({ title, points }: { title: string; points: [string, number][] }) {
  const [ref, width] = useWidth();
  const h = 40;
  const max = Math.max(1, ...points.map(([, v]) => v));
  const min = Math.min(...points.map(([, v]) => v));
  const span = Math.max(1, max - min);
  const x = (i: number) => 2 + (i * (width - 4)) / Math.max(1, points.length - 1);
  const y = (v: number) => 4 + (h - 8) * (1 - (v - min) / span);
  const first = points[0]; const last = points[points.length - 1];
  return (
    <div ref={ref}>
      <div style={{ fontSize: 12.5, color: 'var(--txt-2)' }}>{title}: <b style={{ color: 'var(--txt)' }}>{usd(last[1])}</b> <span className="muted">(from {usd(first[1])} on {dayLabel(first[0])})</span></div>
      <svg width={width} height={h} role="img" aria-label={`${title}: ${usd(first[1])} on ${first[0]}, ${usd(last[1])} on ${last[0]}`}>
        <polyline fill="none" stroke="var(--viz-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={points.map(([, v], i) => `${x(i)},${y(v)}`).join(' ')} />
        <circle cx={x(points.length - 1)} cy={y(last[1])} r={4} fill="var(--viz-1)" stroke="var(--panel)" strokeWidth={2} />
      </svg>
    </div>
  );
}
