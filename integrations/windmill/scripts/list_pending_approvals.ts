// Effigent: approval requests waiting for a decision.
type Effigent = { base_url?: string; api_key: string };

export async function main(effigent: Effigent) {
  const res = await fetch(`${(effigent.base_url || "https://api.effigent.ai").replace(/\/+$/, "")}/api/v1/approvals?state=pending`, {
    headers: { Authorization: `Bearer ${effigent.api_key}` },
  });
  if (!res.ok) throw new Error(`Effigent answered ${res.status}: ${await res.text()}`);
  const all = (await res.json()) as { expires_at: string }[];
  return all.filter((a) => Date.parse(a.expires_at) > Date.now());
}
