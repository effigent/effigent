// Effigent: approve or deny a paused agent action. `approver` is shown to the
// agent and in the console ("approved by …"); the audit trail also records
// the API key. Needs a key with the `approvals` scope.
type Effigent = { base_url?: string; api_key: string };

export async function main(effigent: Effigent, approval_id: string, decision: "approve" | "deny", approver = "", note = "") {
  const res = await fetch(`${(effigent.base_url || "https://api.effigent.ai").replace(/\/+$/, "")}/api/v1/approvals/${encodeURIComponent(approval_id)}/decision`, {
    method: "POST",
    headers: { Authorization: `Bearer ${effigent.api_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ decision, name: approver, note }),
  });
  if (res.status === 409) return { approval_id, skipped: "already decided or expired" };
  if (!res.ok) throw new Error(`Effigent answered ${res.status}: ${await res.text()}`);
  return await res.json();
}
