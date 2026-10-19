/** "What Effigent covers": each kind of agent action, the layer that enforces
 *  it and the decisions available (home page + /docs/enforcement). */
import { COVERAGE, DECISION_STYLE } from './data';

export function CoverageTable() {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'oklch(0.995 0.002 90)', padding: 6 }}>
      <div className="tbl-wrap">
        <table className="cov">
          <thead>
            <tr><th>Agent action</th><th>Enforced by</th><th>Decisions</th></tr>
          </thead>
          <tbody>
            {COVERAGE.map((r) => (
              <tr key={r.what}>
                <td>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{r.what}</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)', marginTop: 2, whiteSpace: 'nowrap' }}>{r.example}</div>
                </td>
                <td style={{ fontSize: 13, color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{r.by}</td>
                <td>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {r.decisions.map((d) => {
                      const s = DECISION_STYLE[d];
                      return <span key={d} className="pill" style={{ color: s.fg, background: s.bg, borderColor: s.border }}>{s.label}</span>;
                    })}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="scroll-hint">Scroll sideways for every column &rarr;</div>
    </div>
  );
}
