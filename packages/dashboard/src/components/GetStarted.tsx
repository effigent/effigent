'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import type { ApiNotifications } from '@/lib/api.ts';
import { summarizePolicy } from '@/lib/live-map.ts';
import { Card, CardHead } from '@/components/ui.tsx';

/** The setup path, worked out from the workspace's real state. Each step
 *  links to where you do it; the card goes away once everything is done. */
export function GetStarted() {
  const { api, endpointRows, policy, latestPolicy, loaded, fixture } = useLive();
  const [notify, setNotify] = useState<ApiNotifications | null>(null);
  const [tools, setTools] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    api.get<ApiNotifications>('/notifications').then((n) => live && setNotify(n)).catch(() => live && setNotify(null));
    Promise.all([api.get<unknown[]>('/api-keys'), api.get<unknown[]>('/webhooks')])
      .then(([k, w]) => live && setTools(k.length + w.length > 0)).catch(() => live && setTools(false));
    return () => { live = false; };
  }, [api]);

  const body = policy?.body ?? '';
  const mode = summarizePolicy(body).mode;
  const machines = endpointRows.filter((e) => !e.revoked).length;
  const steps = [
    { done: machines > 0, title: 'Install on a machine', desc: machines ? `${machines} machine${machines === 1 ? '' : 's'} reporting` : 'One command per machine', href: '/enforcement#enroll' },
    { done: latestPolicy > 0, title: 'Publish your policy', desc: latestPolicy ? `v${latestPolicy} is live` : 'Start from the built-in default', href: '/policies' },
    { done: mode === 'denylist' || mode === 'allowlist', title: 'Turn on blocking', desc: mode ? `Now: ${mode}` : 'Monitor, then denylist', href: '/policies' },
    { done: /_approve\s*:/.test(body), title: 'Ask before risky actions', desc: 'e.g. before a force push', href: '/policies' },
    { done: !!notify && (notify.slack_webhook_set || notify.emails.length > 0), title: 'Approvals in Slack / email', desc: 'Decide from the message', href: '/settings#approvals' },
    { done: tools === true, title: 'Connect your tools', desc: 'Optional: Windmill, Tines', href: '/settings#integrations', optional: true },
  ];
  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.done).length;
  if (!loaded || fixture || done === required.length) return null;
  const next = steps.find((s) => !s.done);

  return (
    <Card>
      <CardHead title={`Get started · ${done} of ${required.length} done`} sub={next ? `Next: ${next.title.toLowerCase()}.` : undefined} />
      <div className="setup-bar"><i style={{ width: `${(done / required.length) * 100}%` }} /></div>
      <div className="setup">
        {steps.map((s, i) => (
          <Link key={s.title} href={s.href} className={`setup-step ${s.done ? 'done' : ''}`}>
            <span className="n">{s.done ? <Ic n="check" size={13} /> : i + 1}</span>
            <span><span className="t">{s.title}</span><span className="d" style={{ display: 'block' }}>{s.desc}</span></span>
          </Link>
        ))}
      </div>
    </Card>
  );
}
