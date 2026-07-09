// VENDORED from packages/core|server (dashboard can't take workspace deps on Vercel).
/**
 * Sensitive-data redaction — applied at the ingest choke point before a run is
 * stored or analyzed. Pattern-based (no LLM in the path): provider API keys,
 * cloud credentials, bearer tokens, PEM blocks, emails, and card-like numbers
 * are replaced with typed placeholders so graphs stay comparable (the same
 * secret always becomes the same token) without ever storing the value.
 */

const RULES: Array<{ name: string; re: RegExp }> = [
  // PEM / private key blocks first (multiline, would otherwise partially match)
  { name: 'PRIVATE_KEY', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // provider + platform keys
  { name: 'API_KEY', re: /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g }, // OpenAI/Anthropic/Stripe-style
  { name: 'API_KEY', re: /\b(?:eff|cck)_[a-f0-9]{16,}\b/g }, // our own capture keys
  { name: 'API_KEY', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g }, // GitHub
  { name: 'API_KEY', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g }, // Slack
  { name: 'API_KEY', re: /\bAIza[A-Za-z0-9_-]{30,}\b/g }, // Google
  { name: 'AWS_KEY', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'BEARER', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  // connection strings with inline credentials
  { name: 'DB_URL', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@[^\s"']+/g },
  // PII
  { name: 'PHONE', re: /(?<![\w.])\+\d{1,3}[-. ]?\(?\d{1,4}\)?[-. ]?\d{2,4}[-. ]?\d{3,7}\b/g }, // E.164 / intl
  { name: 'PHONE', re: /\(\d{3}\)\s?\d{3}[-.]\d{4}\b/g },
  { name: 'PHONE', re: /\b\d{3}[-.]\d{3}[-.]\d{4}\b/g },
  { name: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // key=value credentials — password: x, token=y, api_key: z (values die, keys stay)
  { name: 'CREDENTIAL', re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?[^\s"',;]{4,}/gi },
  { name: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: 'CARD', re: /\b(?:\d[ -]?){13,16}\b/g },
];

/** Replace sensitive values with `[REDACTED:<TYPE>]` placeholders.
 *  Person names are deliberately NOT redacted — they are routine agent context
 *  (ticket assignees, commit authors) and removing them would gut analysis. */
export function redactSensitive(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { name, re } of RULES) out = out.replace(re, `[REDACTED:${name}]`);
  return out;
}

/** True when redaction would change the text (useful for tests/metrics). */
export function containsSensitive(text: string): boolean {
  return RULES.some(({ re }) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}
