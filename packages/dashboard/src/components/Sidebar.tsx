import { nav } from '../data.ts';
import { Ic } from '../icons.tsx';

export function Sidebar({ active, onSelect }: { active: string; onSelect: (key: string) => void }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark"><Ic n="spark" /></span>
        <span className="brand-name">Effigent</span>
      </div>

      {nav.map((block) => (
        <div key={block.group}>
          <div className="nav-group">{block.group}</div>
          {block.items.map(([label, icon, key]) => (
            <div
              key={label}
              className={`nav-item ${key ? '' : 'inert'} ${key && key === active ? 'active' : ''}`}
              onClick={() => key && onSelect(key)}
            >
              <Ic n={icon} /> {label}
            </div>
          ))}
        </div>
      ))}

      <div className="sidebar-foot">
        <div className="live"><span className="dot" /> Effigent is active</div>
        <div className="meta">Runtime compiler for AI agents</div>
      </div>
    </aside>
  );
}
