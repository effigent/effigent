// Effigent: verify a webhook's X-Effigent-Signature and return the event.
// Use it as the preprocessor of an HTTP route with "raw body" enabled:
//   X-Effigent-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
// `secret` is the whsec_… shown when you added the webhook (store it as a secret variable).
import { createHmac, timingSafeEqual } from "node:crypto";

export async function main(raw_body: string, signature: string, secret: string, tolerance_seconds = 300) {
  const parts = Object.fromEntries(signature.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t)) throw new Error("malformed X-Effigent-Signature");
  if (Math.abs(Date.now() / 1000 - t) > tolerance_seconds) throw new Error("X-Effigent-Signature is too old (replay?)");
  const want = createHmac("sha256", secret).update(`${parts.t}.${raw_body}`).digest();
  const got = Buffer.from(parts.v1, "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error("X-Effigent-Signature does not match");
  return JSON.parse(raw_body) as { id: string; type: string; created_at: string; tenant: string; data: any };
}

// As a Windmill preprocessor (HTTP route, raw body on): the runnable then
// gets `event`. The secret is the Windmill secret variable f/effigent/webhook_secret.
export async function preprocessor(event: { kind: string; raw_string?: string | null; headers?: Record<string, string> }) {
  if (event.kind !== "http" && event.kind !== "webhook") throw new Error(`unexpected trigger ${event.kind}`);
  const wmill = await import("windmill-client");
  const secret = await wmill.getVariable("f/effigent/webhook_secret");
  const sig = event.headers?.["x-effigent-signature"] ?? "";
  if (!event.raw_string) throw new Error("enable 'raw body' on this HTTP route");
  return { event: await main(event.raw_string, sig, secret) };
}
