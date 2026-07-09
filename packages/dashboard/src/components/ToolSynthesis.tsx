import { recentTools, topOptimizations } from '../data.ts';
import { Ic } from '../icons.tsx';

function tint(c: string) {
  return { background: `color-mix(in srgb, ${c} 16%, transparent)`, color: c };
}

/** Tools Effigent synthesized for the agents — deterministic replacements for
 *  repeated LLM reasoning. (Demo-backed until the synthesis engine lands.) */
export function ToolSynthesis() {
  return (
    <div className="page-stack">
      <section className="panel panel-pad">
        <div className="panel-title" style={{ marginBottom: 4 }}>Synthesized tools</div>
        <div className="panel-sub" style={{ marginBottom: 16 }}>
          Deterministic functions Effigent generated to replace repeated LLM steps across your agents.
        </div>
        <div className="tool-grid">
          {recentTools.map((t) => (
            <div key={t.name} className="tool-card">
              <div className="tool-card-head">
                <span className="list-ico" style={tint(t.tint)}><Ic n={t.icon} /></span>
                <span className="tool-uses tnum">{t.v}</span>
              </div>
              <div className="mono-name" style={{ fontSize: 14, marginTop: 12 }}>{t.name}</div>
              <div className="s" style={{ marginTop: 4 }}>{t.s}</div>
              <div className="tool-card-foot">
                <span className="badge-det"><Ic n="scale" style={{ width: 11, height: 11 }} /> Deterministic</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel panel-pad">
        <div className="panel-title" style={{ marginBottom: 14 }}>Optimization passes</div>
        {topOptimizations.map((o) => (
          <div key={o.t} className="list-row">
            <span className="list-ico" style={tint(o.tint)}><Ic n={o.icon} /></span>
            <div className="list-main">
              <div className="t">{o.t}</div>
              <div className="s">{o.s}</div>
            </div>
            <span className="list-val" style={{ color: 'var(--green)' }}>{o.v}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
