// Effigent: read one approval request (to re-check it before acting on a webhook).
type Effigent = { base_url?: string; api_key: string };

export async function main(effigent: Effigent, approval_id: string) {
  const res = await fetch(`${(effigent.base_url || "https://api.effigent.ai").replace(/\/+$/, "")}/api/v1/approvals/${encodeURIComponent(approval_id)}`, {
    headers: { Authorization: `Bearer ${effigent.api_key}` },
  });
  if (!res.ok) throw new Error(`Effigent answered ${res.status}: ${await res.text()}`);
  return await res.json();
}
