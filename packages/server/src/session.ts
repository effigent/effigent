/**
 * Human-user auth primitives — password hashing (scrypt) and stateless session
 * tokens (HMAC-signed, JWT-like), both on Node's built-in crypto (no deps).
 * API keys (cck_…) remain the machine/agent credential; this is for dashboard
 * users who belong to a tenant.
 */
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

function secret(): string {
  return process.env.CCOPT_AUTH_SECRET || process.env.CCOPT_ADMIN_TOKEN || 'dev-only-insecure-secret';
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const dk = scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === dk.length && timingSafeEqual(expected, dk);
}

const b64u = (b: Buffer) => b.toString('base64url');

export interface SessionClaims { tid: string; uid: string }

/** Sign a session token valid for `ttlSec` (default 30 days). */
export function signSession(claims: SessionClaims, ttlSec = 60 * 60 * 24 * 30): string {
  const body = { ...claims, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const data = b64u(Buffer.from(JSON.stringify(body)));
  const sig = b64u(createHmac('sha256', secret()).update(data).digest());
  return `${data}.${sig}`;
}

/** Verify + decode a session token, or null if invalid/expired. */
export function verifySession(token: string): SessionClaims | null {
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64u(createHmac('sha256', secret()).update(data).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as SessionClaims & { exp: number };
    if (typeof body.exp !== 'number' || body.exp < Math.floor(Date.now() / 1000)) return null;
    if (!body.tid || !body.uid) return null;
    return { tid: body.tid, uid: body.uid };
  } catch {
    return null;
  }
}
