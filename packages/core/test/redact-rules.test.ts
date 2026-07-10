import { describe, expect, it } from 'vitest';
import {
  applyRedactionRules,
  compileRedactionRules,
  MAX_CUSTOM_RULES,
  redactSensitive,
} from '../src/index.js';

describe('org-defined redaction rules', () => {
  it('compiles valid rules and applies them with typed placeholders', () => {
    const { compiled, errors } = compileRedactionRules([
      { name: 'ticket_id', pattern: 'JIRA-\\d+', enabled: true },
      { name: 'HOSTNAME', pattern: '\\b[a-z0-9-]+\\.corp\\.internal\\b' },
    ]);
    expect(errors).toEqual([]);
    expect(compiled).toHaveLength(2);
    const out = applyRedactionRules('deploy JIRA-1234 to db-7.corp.internal now', compiled);
    expect(out).toBe('deploy [REDACTED:TICKET_ID] to [REDACTED:HOSTNAME] now');
  });

  it('reports invalid entries instead of throwing (ingest must never break)', () => {
    const { compiled, errors } = compileRedactionRules([
      { name: 'BAD REGEX', pattern: '(' },
      { name: 'x', pattern: 'ok' }, // name too short
      { name: 'UNBALANCED', pattern: '(' }, // invalid regex
      { name: 'FINE', pattern: 'secret-\\d+' },
    ]);
    expect(compiled.map((c) => c.name)).toEqual(['FINE']);
    expect(errors.length).toBe(3);
  });

  it('skips disabled rules and caps the count', () => {
    const many = Array.from({ length: MAX_CUSTOM_RULES + 5 }, (_, i) => ({
      name: `RULE_${i}`,
      pattern: `x${i}`,
    }));
    const { compiled, errors } = compileRedactionRules(many);
    expect(compiled.length).toBe(MAX_CUSTOM_RULES);
    expect(errors[0]).toContain('too many');
    const { compiled: none } = compileRedactionRules([{ name: 'OFF', pattern: 'x', enabled: false }]);
    expect(none).toHaveLength(0);
  });

  it('composes after the built-ins at the ingest choke point', () => {
    const { compiled } = compileRedactionRules([{ name: 'EMP_ID', pattern: 'EMP-\\d{5}' }]);
    const raw = 'contact jane@corp.com about EMP-88213';
    const out = applyRedactionRules(redactSensitive(raw), compiled);
    expect(out).toBe('contact [REDACTED:EMAIL] about [REDACTED:EMP_ID]');
  });
});
