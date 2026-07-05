/**
 * Canonicalization — spec §3.2. Replace volatile literals with typed placeholders
 * so that "the same procedure on different data" hashes to the same label.
 *
 * Ordering matters: structured/longer patterns (URLs, UUIDs, timestamps, paths)
 * must be replaced before generic ones (hex ids, numbers) can eat their pieces.
 */

const RE_URL = /https?:\/\/([^\s/"'<>)\]]+)[^\s"'<>)\]]*/g;
const RE_UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
// ISO dates / datetimes, e.g. 2026-07-05, 2026-07-05T10:11:12.345Z, 2026-07-05 10:11
const RE_ISO_TS =
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
// Bare clock times, e.g. 10:42 or 10:42:03
const RE_CLOCK = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
// Hex ids: git SHAs, content hashes. Require ≥7 chars and at least one digit so
// ordinary words ("deadbeef" passes, "accede" does not).
const RE_HEX_ID = /(?<![A-Za-z0-9])(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{7,64}(?![A-Za-z0-9])/g;
// Unix-style paths with at least two segments; captures a trailing extension.
const RE_PATH = /(?:~|\.{1,2})?(?:\/[\w.@+~-]+){2,}\/?/g;
// Git refs: refs/..., origin/..., PR/issue "#123"
const RE_GIT_REF = /\b(?:refs\/[\w/.-]+|origin\/[\w/.-]+)\b/g;
const RE_ISSUE_REF = /#\d+\b/g;
// Long base64-ish / opaque tokens
const RE_OPAQUE = /\b[A-Za-z0-9_-]{24,}\b/g;
const RE_NUM = /\b\d+(?:\.\d+)?\b/g;

function replacePaths(s: string): string {
  return s.replace(RE_PATH, (m) => {
    const last = m.replace(/\/+$/, '').split('/').pop() ?? '';
    const dot = last.lastIndexOf('.');
    const ext = dot > 0 ? last.slice(dot) : '';
    // Extensions are kept only when they look like one (short, alphanumeric).
    return ext && /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? `<PATH:${ext}>` : '<PATH>';
  });
}

// C0/C1 control chars (except \n and \t) and lone surrogates — these appear in
// real payloads (binary output, JSON-escaped NULs re-parsed downstream) and
// must never survive into labels or canonical values.
// eslint-disable-next-line no-control-regex
const RE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const RE_LONE_HI_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
const RE_LONE_LO_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripControlChars(input: string): string {
  return input
    .replace(RE_CONTROL, '')
    .replace(RE_LONE_HI_SURROGATE, '')
    .replace(RE_LONE_LO_SURROGATE, '');
}

/** Replace volatile literals in a string. Preserves case and spacing. */
export function canonicalizeText(input: string): string {
  let s = stripControlChars(input);
  s = s.replace(RE_URL, (_m, host: string) => `<URL:${host.replace(/:\d+$/, '')}>`);
  s = s.replace(RE_UUID, '<ID>');
  s = s.replace(RE_EMAIL, '<EMAIL>');
  s = s.replace(RE_ISO_TS, '<TS>');
  s = replacePaths(s);
  s = s.replace(RE_GIT_REF, '<REF>');
  s = s.replace(RE_ISSUE_REF, '<REF>');
  s = s.replace(RE_CLOCK, '<TS>');
  s = s.replace(RE_HEX_ID, '<ID>');
  s = s.replace(RE_OPAQUE, (m) => (/\d/.test(m) ? '<ID>' : m));
  s = s.replace(RE_NUM, '<NUM>');
  return s;
}

/**
 * Template extraction for free text — spec §3.2: lowercase, collapse whitespace,
 * volatile spans replaced; keep the skeleton.
 */
export function templateOf(input: string, maxLen = 240): string {
  const t = canonicalizeText(input.toLowerCase()).replace(/\s+/g, ' ').trim();
  return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
}

/**
 * Canonicalize a JSON-ish tool input into a stable string: keys sorted, string
 * values canonicalized, long values elided to their template.
 */
export function canonicalizeJsonValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(templateOf(value, 160));
  if (typeof value === 'number') return '<NUM>';
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (depth > 3) return '[…]';
    return `[${value.map((v) => canonicalizeJsonValue(v, depth + 1)).join(',')}]`;
  }
  if (typeof value === 'object') {
    if (depth > 3) return '{…}';
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([k, v]) => `${k}:${canonicalizeJsonValue(v, depth + 1)}`)
      .join(',')}}`;
  }
  return String(value);
}

/**
 * The *shape* of a tool input: which keys are present, and for the primary
 * text-bearing keys a short template. This is what goes into the L1 label.
 */
export function toolInputShape(input: unknown, maxLen = 160): string {
  if (input === null || input === undefined || typeof input !== 'object') {
    return templateOf(String(input ?? ''), maxLen);
  }
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string') {
      parts.push(`${k}=${templateOf(v, 80)}`);
    } else if (typeof v === 'number') {
      parts.push(`${k}=<NUM>`);
    } else if (typeof v === 'boolean') {
      parts.push(`${k}=${v}`);
    } else {
      parts.push(`${k}=${canonicalizeJsonValue(v, 1)}`);
    }
  }
  const s = parts.join(' ');
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

/** Label for a tool node: tool name + canonicalized input shape. */
export function toolLabel(toolName: string, input: unknown): string {
  return `tool:${toolName} ${toolInputShape(input)}`.trim();
}

/** Coarse shape of an output: kind + size bucket + leading template. */
export function outputShape(text: string): string {
  const len = text.length;
  const bucket = len === 0 ? 'empty' : len < 200 ? 'S' : len < 2000 ? 'M' : len < 20000 ? 'L' : 'XL';
  return `${bucket}:${templateOf(text, 80)}`;
}

/** Label for a model turn: role + instruction template + output shape. */
export function modelTurnLabel(role: string, text: string): string {
  return `${role}:${templateOf(text, 160)}`;
}
