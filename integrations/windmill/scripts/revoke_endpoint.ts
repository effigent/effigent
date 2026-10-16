// Effigent: revoke a machine (it stops receiving policy; its events are refused).
// Needs a key with the `endpoints` scope.
type Effigent = { base_url?: string; api_key: string };

export async function main(effigent: Effigent, endpoint_id: string) {
  const res = await fetch(`${(effigent.base_url || "https://api.effigent.ai").replace(/\/+$/, "")}/api/v1/endpoints/${encodeURIComponent(endpoint_id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${effigent.api_key}` },
  });
  if (!res.ok) throw new Error(`Effigent answered ${res.status}: ${await res.text()}`);
  return await res.json();
}
