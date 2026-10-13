/** The per-layer coverage matrix (home page + /docs/enforcement). */
import { COVERAGE, COVERAGE_COLS, COVER_STYLE } from './data';

export function CoverageTable() {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'oklch(0.995 0.002 90)', padding: 6 }}>
      <div className="tbl-wrap">
        <table className="cov">
          <thead>
            <tr><th>Action</th>{COVERAGE_COLS.map((c) => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {COVERAGE.map((r) => (
              <tr key={r.what}>
                <td>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{r.what}</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)', marginTop: 2, whiteSpace: 'nowrap' }}>{r.example}</div>
                </td>
                {r.cells.map((c, i) => {
                  const s = COVER_STYLE[c];
                  return <td key={i}><span className="pill" style={{ color: s.fg, background: s.bg, borderColor: s.border }}>{s.label}</span></td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="scroll-hint">Scroll sideways for all four layers &rarr;</div>
    </div>
  );
}
