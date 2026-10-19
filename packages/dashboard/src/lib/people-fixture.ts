/**
 * Demo Mode's People: the same JSON shapes as GET /api/v1/people and its
 * writes, in memory only. People and machines match the Pricing Leaks sample.
 */
import { ApiError, type ApiIdentityKind, type ApiPeople, type ApiPerson, type ApiSighting, type ApiSuggestion, type ApiVia } from './api.ts';

const at = (p: string) => `${p}@acme.example`;
const KINDS: ApiIdentityKind[] = ['os_user', 'git_email', 'host', 'github', 'email', 'api_key'];

export function createPeopleFixture(now: number) {
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const person = (who: string, name: string, ids: [ApiIdentityKind, string][], src: 'manual' | 'suggestion' = 'manual'): ApiPerson => ({
    email: at(who), name, updated_by: 'user_demo', updated_at: iso(60 * 24 * 3),
    identities: ids.map(([kind, value]) => ({ kind, value, email: at(who), source: src, created_by: 'user_demo', created_at: iso(60 * 24 * 3) })),
  });
  let people: ApiPerson[] = [
    person('jane.doe', 'Jane Doe', [['os_user', 'jane'], ['host', 'jane-mbp'], ['github', 'janedoe']]),
    person('alex.wang', 'Alex Wang', [['os_user', 'alex'], ['github', 'awang-dev']]),
    person('sarah.lee', 'Sarah Lee', [['os_user', 'sarah'], ['git_email', 'sarah@hey.dev'], ['github', 'sarahlee']]),
    person('raj.patel', 'Raj Patel', [['os_user', 'raj'], ['api_key', 'raj-laptop-key']]),
    person('dan.cohen', 'Dan Cohen', [['github', 'dcohen'], ['host', 'dan-dev-vm']]),
    person('lena.kim', 'Lena Kim', [['github', 'lenakim']]),
    person('mike.tan', 'Mike Tan', [['os_user', 'mike']], 'suggestion'),
  ];
  const sight = (hostname: string, os_user: string, git_email: string, agents: string[], events: number, minAgo: number, owner = ''): ApiSighting =>
    ({ endpoint_id: `ep-${hostname}`, hostname, owner, os_user, git_email, agents, events, last_seen: iso(minAgo) });
  const raw: ApiSighting[] = [
    sight('jane-mbp', 'jane', at('jane.doe'), ['claude-code'], 4120, 12),
    sight('alex-mbp', 'alex', 'alex@wang.io', ['cursor-agent'], 2210, 40),
    sight('sarah-mbp', 'sarah', 'sarah@hey.dev', ['claude-code', 'cursor-agent'], 3876, 8),
    sight('raj-ws', 'raj', at('raj.patel'), ['claude-code'], 9934, 3),
    sight('mike-mbp', 'mike', at('mike.tan'), ['codex', 'gemini-cli'], 1530, 95),
    sight('emma-mba', 'emma', at('emma.brooks'), ['claude-code'], 610, 60 * 20),
    sight('priya-mba', 'priya', at('priya.shah'), ['aider', 'opencode'], 880, 60 * 5),
    sight('prod-bastion-01', 'ubuntu', at('omar.haddad'), ['claude-code'], 214, 60 * 30),
    sight('noa-mbp', 'noa', '', ['claude-code'], 1290, 60 * 2, at('noa.levi')),
    sight('ci-runner-03', 'runner', '', ['claude-code'], 5022, 20),
  ];
  let suggestions: ApiSuggestion[] = [
    { kind: 'person', value: at('noa.levi'), email: at('noa.levi'), name: 'Noa Levi', reason: 'Has a Cursor seat', confidence: 'high' },
    { kind: 'person', value: at('tom.weiss'), email: at('tom.weiss'), name: 'Tom Weiss', reason: 'Has a Cursor seat', confidence: 'high' },
    { kind: 'os_user', value: 'emma', email: at('emma.brooks'), name: 'Emma Brooks', reason: `OS user emma on emma-mba commits as ${at('emma.brooks')}`, confidence: 'medium' },
    { kind: 'os_user', value: 'priya', email: at('priya.shah'), name: 'Priya Shah', reason: `OS user priya on priya-mba commits as ${at('priya.shah')}`, confidence: 'medium' },
    { kind: 'os_user', value: 'ubuntu@prod-bastion-01', email: at('omar.haddad'), name: 'Omar Haddad', reason: `OS user ubuntu on prod-bastion-01 commits as ${at('omar.haddad')}`, confidence: 'medium' },
    { kind: 'git_email', value: 'alex@wang.io', email: at('alex.wang'), reason: 'Used on alex-mbp, which is ' + at('alex.wang') + '’s (mapped OS user)', confidence: 'medium' },
    { kind: 'github', value: 'omar-h_acme', email: at('omar.haddad'), reason: 'GitHub Copilot seat omar-h_acme looks like ' + at('omar.haddad'), confidence: 'low' },
  ];

  /** Who each sighting is now: the same order as spend.Directory.ObsPerson. */
  const resolve = (s: ApiSighting): ApiSighting => {
    const has = (kind: ApiIdentityKind, value: string) => people.find((p) => p.identities.some((i) => i.kind === kind && i.value === value))?.email;
    const known = (e: string) => people.some((p) => p.email === e) || [at('emma.brooks'), at('priya.shah'), at('omar.haddad'), at('noa.levi'), at('tom.weiss')].includes(e);
    let person: string | undefined; let via: ApiVia = '';
    const os = s.os_user && (has('os_user', `${s.os_user}@${s.hostname}`) ?? has('os_user', s.os_user));
    if (os) { person = os; via = 'os_user'; }
    else if (s.git_email && (has('git_email', s.git_email) ?? has('email', s.git_email) ?? (known(s.git_email) ? s.git_email : undefined))) {
      person = has('git_email', s.git_email) ?? has('email', s.git_email) ?? s.git_email; via = 'git_email';
    } else if (s.owner) { person = s.owner; via = 'owner'; }
    else if (has('host', s.hostname)) { person = has('host', s.hostname); via = 'host'; }
    return { ...s, person, via };
  };
  const page = (): ApiPeople => {
    const sightings = raw.map(resolve);
    return {
      people: people.slice().sort((a, b) => a.email.localeCompare(b.email)), suggestions, sightings,
      unattributed: [...new Set(sightings.filter((s) => !s.person).map((s) => s.hostname))], kinds: KINDS, window_days: 30,
    };
  };
  const owner = (kind: string, value: string) => people.find((p) => p.identities.some((i) => i.kind === kind && i.value === value))?.email;
  const ensure = (email: string, name = '') => {
    let p = people.find((x) => x.email === email);
    if (!p) { p = { email, name, identities: [], updated_by: 'user_demo', updated_at: new Date().toISOString() }; people = [...people, p]; }
    return p;
  };
  const conflict = (kind: string, value: string, email: string) => {
    const o = owner(kind, value);
    return o && o !== email ? new ApiError(409, `${kind} "${value}" is already mapped to ${o}`) : null;
  };

  return {
    get(path: string): ApiPeople | undefined {
      return path === '/people' ? page() : undefined;
    },
    /** undefined = not a People route */
    send(method: string, path: string, body: unknown): unknown | ApiError | undefined {
      const b = (body ?? {}) as Record<string, unknown>;
      const [route, q] = path.split('?');
      if (route === '/people/identities' && method === 'POST') {
        const email = String(b.email ?? '').trim().toLowerCase();
        const kind = String(b.kind ?? ''); const value = String(b.value ?? '').trim().toLowerCase();
        if (!email.includes('@')) return new ApiError(400, `"${email}" isn't an email address`);
        if (kind !== 'person' && !KINDS.includes(kind as ApiIdentityKind)) return new ApiError(400, `kind must be one of ${KINDS.join(', ')}`);
        if (kind !== 'person' && !value) return new ApiError(400, `${kind}: a value without spaces, at most 254 characters`);
        const c = kind !== 'person' && conflict(kind, value, email);
        if (c) return c;
        const p = ensure(email, String(b.name ?? ''));
        if (kind !== 'person' && !p.identities.some((i) => i.kind === kind && i.value === value)) {
          p.identities.push({ kind: kind as ApiIdentityKind, value, email, source: b.source === 'suggestion' ? 'suggestion' : 'manual', created_by: 'user_demo', created_at: new Date().toISOString() });
        }
        suggestions = suggestions.filter((x) => !(x.kind === kind && x.value === (kind === 'person' ? email : value)));
        return { kind, value: kind === 'person' ? email : value, email };
      }
      if (route === '/people/identities' && method === 'DELETE') {
        const sp = new URLSearchParams(q ?? '');
        const kind = sp.get('kind') ?? ''; const value = (sp.get('value') ?? '').toLowerCase();
        const o = owner(kind, value);
        if (!o) return new ApiError(404, 'that identity isn\'t mapped');
        people = people.map((p) => (p.email === o ? { ...p, identities: p.identities.filter((i) => !(i.kind === kind && i.value === value)) } : p));
        return { ok: true };
      }
      const one = route.match(/^\/people\/([^/]+)$/);
      if (one) {
        const email = decodeURIComponent(one[1]).toLowerCase();
        if (method === 'DELETE') {
          if (!people.some((p) => p.email === email)) return new ApiError(404, 'no such person');
          people = people.filter((p) => p.email !== email);
          return { ok: true };
        }
        if (method === 'PUT') {
          if (!email.includes('@')) return new ApiError(400, `"${email}" isn't an email address`);
          const ids = ((b.identities ?? []) as { kind: string; value: string; source?: string }[]).map((i) => ({ kind: i.kind, value: i.value.trim().toLowerCase(), source: i.source }));
          for (const i of ids) {
            if (!KINDS.includes(i.kind as ApiIdentityKind)) return new ApiError(400, `kind must be one of ${KINDS.join(', ')}`);
            const c = conflict(i.kind, i.value, email);
            if (c) return c;
          }
          const p = ensure(email);
          const next: ApiPerson = { ...p, name: String(b.name ?? '').trim(), updated_at: new Date().toISOString(), updated_by: 'user_demo',
            identities: ids.map((i) => p.identities.find((x) => x.kind === i.kind && x.value === i.value)
              ?? { kind: i.kind as ApiIdentityKind, value: i.value, email, source: i.source === 'suggestion' ? 'suggestion' : 'manual', created_by: 'user_demo', created_at: new Date().toISOString() }) };
          people = people.map((x) => (x.email === email ? next : x));
          return next;
        }
      }
      return undefined;
    },
  };
}
