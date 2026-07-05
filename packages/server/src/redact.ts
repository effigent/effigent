/**
 * Secret redaction — applied to transcript content at render time and to every
 * packet sent to an external LLM. Masks credential-shaped values while keeping
 * enough prefix to recognize what was there.
 *
 * NOTE (honest limit): this is render/egress redaction. The raw transcripts in
 * the blob store and the trimmed copies in Postgres still contain the original
 * bytes — protecting those is about who holds DB/bucket/owner credentials.
 */

interface Rule {
  pattern: RegExp;
  /** Replacement keeps a short recognizable prefix. */
  replace: (match: string) => string;
}

const mask = (m: string, keep = 6) => `${m.slice(0, keep)}…[REDACTED]`;

const RULES: Rule[] = [
  // Vendor API keys / tokens
  { pattern: /\bsk-(?:ant|or|proj|live|test)?-?[A-Za-z0-9_-]{16,}\b/g, replace: (m) => mask(m) },
  { pattern: /\bcck_[a-f0-9]{16,}\b/g, replace: (m) => mask(m) },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: (m) => mask(m) },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: (m) => mask(m, 11) },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, replace: (m) => mask(m, 4) },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: (m) => mask(m, 5) },
  { pattern: /\bwhsec_[A-Za-z0-9]{16,}\b/g, replace: (m) => mask(m) },
  { pattern: /\bnpg_[A-Za-z0-9]{8,}\b/g, replace: (m) => mask(m, 4) },
  { pattern: /\bAIza[A-Za-z0-9_-]{20,}\b/g, replace: (m) => mask(m, 4) },
  // JWTs
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: () => 'eyJ…[REDACTED-JWT]' },
  // Connection strings with embedded passwords
  {
    pattern: /\b([a-z][a-z0-9+]*:\/\/[^:\s/]+):([^@\s/]+)@/gi,
    replace: (m) => m.replace(/:[^@:/]+@/, ':[REDACTED]@'),
  },
  // Authorization headers / key-value credential assignments
  {
    pattern: /\b(authorization\s*:\s*bearer\s+)[^\s"'&]+/gi,
    replace: (m) => m.replace(/(bearer\s+)[^\s"'&]+/i, '$1[REDACTED]'),
  },
  {
    pattern: /\b(x-api-key\s*[:=]\s*)[^\s"'&]+/gi,
    replace: (m) => m.replace(/([:=]\s*)[^\s"'&]+$/, '$1[REDACTED]'),
  },
  {
    pattern:
      /\b([A-Za-z0-9_-]*(?:api[_-]?key|apikey|secret|password|passwd|token|access[_-]?key|private[_-]?key|credential)s?["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"'&,;]{6,}/gi,
    replace: (m) =>
      m.replace(/([:=]\s*["']?)[^\s"'&,;]+$/, '$1[REDACTED]'),
  },
  // PEM blocks
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => '-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----',
  },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replace as (substring: string, ...args: unknown[]) => string);
  }
  return out;
}

/** Deep-redact every string in an object (for LLM packets). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
