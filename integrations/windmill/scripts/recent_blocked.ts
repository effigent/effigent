// Effigent: the latest blocked agent actions (e.g. for a daily report).
type Effigent = { base_url?: string; api_key: string };

export async function main(effigent: Effigent, limit = 100) {
  const res = await fetch(`${(effigent.base_url || "https://api.effigent.ai").replace(/\/+$/, "")}/api/v1/events?type=blocked&limit=${limit}`, {
    headers: { Authorization: `Bearer ${effigent.api_key}` },
  });
  if (!res.ok) throw new Error(`Effigent answered ${res.status}: ${await res.text()}`);
  return await res.json();
}
