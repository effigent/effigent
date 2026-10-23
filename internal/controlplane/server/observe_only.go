package server

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/effigent/effigent/internal/controlplane/store"
)

// Observe-only kernels (cmd/effigentd/kernelfloor.go): a Linux machine whose
// kernel can't block (older than 5.12, no BTF, BPF LSM off) runs its kernel
// layer observe-only and says why with every heartbeat (kernel.observe_only,
// migration 023). That is a known state, not tampering:
//   - its kernel policy load failures raise no policy_load_failed alert
//     (effigentd builds that know the state report them as info anyway);
//   - entering the state is audited once, endpoint.observe_only (console only:
//     no email, no webhook), and again only after the machine left it and
//     came back. The previous report is the stored kernel column, swapped
//     under a row lock, so no extra column is needed.

// observeOnlyOf is the reason in a kernel report, "" when the kernel can block
// or the build doesn't say.
func observeOnlyOf(kernel json.RawMessage) string {
	var k struct {
		ObserveOnly string `json:"observe_only"`
	}
	_ = json.Unmarshal(kernel, &k)
	return strings.TrimSpace(k.ObserveOnly)
}

// kernelReported audits a machine whose kernel layer went observe-only
// between the previous report and this one (the first report included).
func (s *Server) kernelReported(ctx context.Context, ep store.Endpoint, prev, now json.RawMessage) {
	why := observeOnlyOf(now)
	if why == "" || observeOnlyOf(prev) != "" {
		return
	}
	var k struct {
		Sensor  string `json:"sensor"`
		Release string `json:"release"`
	}
	_ = json.Unmarshal(now, &k)
	s.auditSystem(ctx, ep.Tenant, "endpoint.observe_only", ep.ID, map[string]any{
		"hostname": ep.Hostname, "os": ep.OS, "reason": why, "release": k.Release, "sensor": k.Sensor,
		"channels": map[string]string{"email": "off: shown in the console (Machines), not emailed"},
	})
}
