'use client';

import { HELP } from '@/lib/help.tsx';
import { useMemo, useState } from 'react';
import { RANGE_MS, useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { ms } from '@/lib/live-map.ts';
import { Card, CardHead, PageGuide, PageHead, Seg } from '@/components/ui.tsx';
import { RangeSelect } from '@/components/RangeSelect.tsx';
import { AuditTrail } from '@/components/AuditTrail.tsx';
import { ActivityEvents } from '@/components/ActivityEvents.tsx';
import { EventEvidence } from '@/components/EventEvidence.tsx';

export function Audit({ initialQuery, initialOutcome, initialTab = 'events', initialRisky = false }: {
  initialQuery?: string; initialOutcome?: string; initialTab?: 'events' | 'trail'; initialRisky?: boolean;
}) {
  const { range } = useStore();
  const { consoleEvents, audit, now } = useLive();
  const [tab, setTab] = useState<'events' | 'trail'>(initialTab);
  const since = now - RANGE_MS[range];
  const all = useMemo(() => consoleEvents.filter((e) => (e.at ?? 0) >= since), [consoleEvents, since]);
  const trail = useMemo(() => audit.filter((a) => (ms(a.at) ?? 0) >= since), [audit, since]);

  return (
    <div className="page">
      <PageHead info={HELP.audit} title="Activity & Audit" sub="Every agent action effigentd reported, and every change made in this console — attributable and tamper-evident.">
        {tab === 'events' && <RangeSelect />}
      </PageHead>
      <PageGuide id="audit" steps={[<><b>Agent events</b>: everything agents ran, opened and reached, with what policy did</>, <><b>Admin trail</b>: every policy, approval and setting change — tamper-evident</>, <>Filter by time and result, then <b>Export CSV</b> for compliance</>]} />

      <div className="grid-4">
        <Card className="mini-stat"><div className="k">Agent events</div><div className="v">{all.length}</div><div className="s">in the newest {consoleEvents.length} events</div></Card>
        <Card className="mini-stat"><div className="k">Blocked</div><div className="v" style={{ color: 'var(--red)' }}>{all.filter((e) => e.outcome === 'blocked').length}</div><div className="s">by policy, in the newest {consoleEvents.length}</div></Card>
        <Card className="mini-stat"><div className="k">Would block</div><div className="v" style={{ color: 'var(--orange, var(--gold))' }}>{all.filter((e) => e.outcome === 'would_block').length}</div><div className="s">matched in monitor / learn mode</div></Card>
        <Card className="mini-stat"><div className="k">Console changes</div><div className="v">{trail.length}</div><div className="s">{trail.filter((a) => a.action === 'policy.publish').length} policy publishes · {trail.filter((a) => a.action.startsWith('denied.')).length} denied</div></Card>
      </div>

      <div className="toolbar">
        <Seg value={tab} onChange={setTab} options={[{ id: 'events', label: 'Agent events' }, { id: 'trail', label: 'Console audit trail' }]} />
      </div>

      {tab === 'events' ? (
        <>
          <ActivityEvents initialQuery={initialQuery} initialOutcome={initialOutcome} initialRisky={initialRisky} />
          <EventEvidence />
        </>
      ) : (
        <AuditTrail />
      )}

      <div className="grid-3">
        <Card><CardHead title="Where events come from" sub="effigentd attributes every exec, sensitive file open and outbound connect to the agent that caused it, and ships them to the control plane in batches." /></Card>
        <Card><CardHead title="Tamper evidence" sub="Agent events and console changes are append-only and hash-chained. Verify recomputes the chains on the server and names anything edited, removed or inserted." /></Card>
        <Card><CardHead title="Evidence export" sub="CSV of every matching event or console change, and the daily S3 archives past 90 days, for SOC 2 / ISO 27001 evidence." /></Card>
      </div>
    </div>
  );
}
