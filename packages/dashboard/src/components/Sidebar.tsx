import { nav } from '../data.ts';
import { Ic } from '../icons.tsx';

export function Sidebar({
  active,
  onSelect,
  open,
  onClose,
}: {
  active: string;
  onSelect: (key: string) => void;
  /** Mobile off-canvas state — ignored on desktop, where the sidebar is static. */
  open?: boolean;
  onClose?: () => void;
}) {
  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="brand">
        {/* eslint-disable-next-line @next/next/no-img-element -- tiny static asset */}
        <img src="/logo_effigent.webp" alt="Effigent" className="brand-wordmark" />
        <button className="sidebar-close" onClick={onClose} aria-label="Close menu">
          <Ic n="x" />
        </button>
      </div>

      {nav.map((block) => (
        <div key={block.group}>
          <div className="nav-group">{block.group}</div>
          {block.items.map(([label, icon, key]) => (
            <div
              key={label}
              className={`nav-item ${key ? '' : 'inert'} ${key && key === active ? 'active' : ''}`}
              onClick={() => {
                if (!key) return;
                onSelect(key);
                onClose?.();
              }}
            >
              <Ic n={icon} /> {label}
            </div>
          ))}
        </div>
      ))}

      <div className="sidebar-foot">
        <div className="live"><span className="dot" /> Effigent is active</div>
        <div className="meta">The self-optimizing runtime for AI agents.</div>
      </div>
    </aside>
  );
}
