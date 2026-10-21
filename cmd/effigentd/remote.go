package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/effigent/effigent/internal/endpoint/api"
	"github.com/effigent/effigent/internal/endpoint/cpclient"
	"github.com/effigent/effigent/internal/endpoint/engine"
	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/hooks"
	"github.com/effigent/effigent/internal/endpoint/policy"
	"github.com/effigent/effigent/internal/shared/cloudtoken"
)

// Remote hook mode (docs/cloud-agents.md): agents that run in a vendor's
// cloud (Claude Code on the web, GitHub Copilot's cloud agent, Cursor cloud
// agents) have no effigentd next to them, only the repository's hook
// config and a setup step. There `effigentd hook <agent> --remote` is the
// whole endpoint for one tool call: it loads the cloud environment's signed
// policy (cached in the state dir, refreshed from the control plane when
// older than EFFIGENT_REMOTE_REFRESH, default 60s), decides the call with
// the same evaluator the daemon uses, files approvals with the control
// plane, and posts the call's events before answering.
//
// Credentials: $EFFIGENT_CLOUD_TOKEN (efc_…, from the console) or the
// endpoint.json `effigentd cloud-setup` wrote to the state dir
// ($EFFIGENT_STATE_DIR, default /var/tmp/effigent-cloud). No policy (never synced,
// control plane unreachable) denies, unless EFFIGENT_REMOTE_FAIL_OPEN=1,
// which decides with the built-in default policy instead.

func remoteMode(args []string) bool {
	for _, a := range args {
		if a == "--remote" || a == "-remote" {
			return true
		}
	}
	return os.Getenv("EFFIGENT_CLOUD_TOKEN") != ""
}

// cloudStateDir is $EFFIGENT_STATE_DIR, else /var/tmp/effigent-cloud: a
// fixed path, because a vendor's setup step and its agent may not share a
// home directory (Copilot's setup steps run as the Actions runner user, the
// agent with HOME=/root). A directory there that belongs to another user
// (planted on a shared machine) is skipped for ~/.effigent-cloud.
func cloudStateDir() string {
	if d := strings.TrimSpace(os.Getenv("EFFIGENT_STATE_DIR")); d != "" {
		return d
	}
	shared := filepath.Join(os.TempDir(), "effigent-cloud")
	if runtime.GOOS != "windows" {
		shared = "/var/tmp/effigent-cloud"
	}
	if ownedBySelfOrRoot(shared) {
		return shared
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return shared
	}
	return filepath.Join(home, ".effigent-cloud")
}

func stateFromToken(s string) (*cpclient.State, error) {
	t, err := cloudtoken.Decode(s)
	if err != nil {
		return nil, err
	}
	return &cpclient.State{Server: t.Server, EndpointID: t.EndpointID, Secret: t.Secret, Tenant: t.Tenant,
		ServerPublicKey: t.ServerPublicKey}, nil
}

// cloudState: the token in the environment wins over the state dir's.
func cloudState(dir string) (*cpclient.State, error) {
	if t := os.Getenv("EFFIGENT_CLOUD_TOKEN"); t != "" {
		return stateFromToken(t)
	}
	return cpclient.LoadState(dir)
}

func envBool(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func remoteRefresh() time.Duration {
	if d, err := time.ParseDuration(os.Getenv("EFFIGENT_REMOTE_REFRESH")); err == nil && d >= 0 {
		return d
	}
	return 60 * time.Second
}

func remoteLogf(f string, a ...any) {
	if envBool("EFFIGENT_HOOK_DEBUG") {
		fmt.Fprintf(os.Stderr, "effigentd: "+f+"\n", a...)
	}
}

// remoteHook decides one tool call without a daemon and returns what the
// agent's hook prints.
func remoteHook(name string, ag hookAgent, payload []byte, budget time.Duration) []byte {
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), budget-time.Second)
	defer cancel()
	dir := cloudStateDir()
	failOpen := envBool("EFFIGENT_REMOTE_FAIL_OPEN")
	st, err := cloudState(dir)
	if err != nil {
		if failOpen {
			return ag.output(hooks.Decision{})
		}
		return ag.failClosed("this cloud environment has no Effigent credentials (set EFFIGENT_CLOUD_TOKEN, or run effigentd cloud-setup in the setup step)")
	}
	_ = os.MkdirAll(dir, 0o700)
	work := writableDir(dir) // the policy cache, spool and session marks

	var mu sync.Mutex
	var evs []event.Event
	collect := func(e event.Event) { mu.Lock(); evs = append(evs, e); mu.Unlock() }
	pol, raw, _ := policy.Load("")
	eng := engine.New(pol, raw, nil, collect, remoteLogf, false)
	client := &cpclient.Client{State: st, Dir: dir, Logf: remoteLogf, AgentVersion: version,
		Apply: func(ctx context.Context, body []byte) error {
			_, err := eng.SetPolicy(ctx, body)
			return err
		}}
	if err := client.LoadCached(ctx); err != nil {
		remoteLogf("cached policy: %v", err)
	}
	if work != dir {
		// The setup step's state is read-only for this user: what it cached
		// first, then this user's own newer copy.
		client.Dir = work
		_ = client.LoadCached(ctx)
	}
	reachable := true
	marker := filepath.Join(work, "synced")
	if fi, err := os.Stat(marker); client.Version() == 0 || err != nil || time.Since(fi.ModTime()) > remoteRefresh() {
		wait := 3 * time.Second
		if client.Version() == 0 {
			wait = 6 * time.Second // nothing cached: worth waiting a little longer
		}
		sctx, scancel := context.WithTimeout(ctx, wait)
		err := client.SyncOnce(sctx)
		scancel()
		if err != nil {
			remoteLogf("control plane sync: %v", err)
			reachable = !isNetErr(err)
		} else {
			touch(marker)
		}
	}

	var out []byte
	if client.Version() == 0 && !failOpen {
		collect(event.Event{Time: time.Now(), Type: event.Blocked, Severity: "high", Agent: ag.name, Kind: "tool", Rule: "remote",
			Message: "no policy: the control plane could not be reached before this cloud environment's first sync"})
		out = ag.failClosed("this cloud environment has no Effigent policy yet and the control plane could not be reached")
	} else {
		h := hookHandlerSeen(eng, func() *cpclient.Client { return client }, sessionMarks(filepath.Join(work, "sessions")))
		call := api.HookCall{Agent: name, Payload: payload, Budget: budget - time.Since(start), Env: hooks.AgentEnv(os.Environ())}
		if u, err := user.Current(); err == nil {
			call.OSUser = u.Username
		}
		out, err = h(ctx, call)
		if err != nil {
			out = ag.failClosed("effigentd could not decide this action")
		}
	}

	// The events go out before the answer: a cloud session ends without
	// warning, and nothing else is left to send them later.
	left := budget - time.Since(start) - 500*time.Millisecond
	ectx, ecancel := context.WithTimeout(context.Background(), min(3*time.Second, max(left, 200*time.Millisecond)))
	defer ecancel()
	shipEvents(ectx, st, filepath.Join(work, "spool"), evs, reachable)
	return out
}

// isNetErr: the control plane didn't answer (as opposed to answering with an error).
func isNetErr(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) || errors.Is(err, context.DeadlineExceeded)
}

// writableDir is dir if this user can write it, else ~/.effigent-cloud
// (the setup step ran as root, the agent doesn't).
func writableDir(dir string) string {
	if f, err := os.CreateTemp(dir, ".w-*"); err == nil {
		f.Close()
		os.Remove(f.Name())
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return dir
	}
	own := filepath.Join(home, ".effigent-cloud")
	if os.MkdirAll(own, 0o700) != nil {
		return dir
	}
	return own
}

func touch(p string) {
	now := time.Now()
	if os.Chtimes(p, now, now) != nil {
		_ = os.WriteFile(p, nil, 0o600)
	}
}

// sessionMarks remembers the sessions already reported (agent_start) as
// files in dir, since every tool call is a new process.
func sessionMarks(dir string) func(string) bool {
	return func(key string) bool {
		_ = os.MkdirAll(dir, 0o700)
		sum := sha256.Sum256([]byte(key))
		f, err := os.OpenFile(filepath.Join(dir, hex.EncodeToString(sum[:16])), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return true // exists, or can't be recorded: don't report a session start on every call
		}
		f.Close()
		if ents, err := os.ReadDir(dir); err == nil && len(ents) > 100 {
			for _, e := range ents {
				if fi, err := e.Info(); err == nil && time.Since(fi.ModTime()) > 24*time.Hour {
					os.Remove(filepath.Join(dir, e.Name()))
				}
			}
		}
		return false
	}
}

const spoolMax = 2000 // batches kept while the control plane is unreachable

// shipEvents posts this call's events as one batch, then replays a few
// batches earlier calls couldn't send (oldest first). A batch that can't be
// sent waits in the spool; the batch id lets the control plane store a
// replayed batch once.
func shipEvents(ctx context.Context, st *cpclient.State, spool string, evs []event.Event, tryNow bool) {
	var b []byte
	if len(evs) > 0 {
		id := make([]byte, 16)
		_, _ = rand.Read(id)
		b, _ = json.Marshal(map[string]any{"batch_id": "r" + hex.EncodeToString(id), "events": evs})
	}
	if b != nil {
		var err error = errors.New("control plane unreachable")
		if tryNow {
			err = postBatch(ctx, st, b)
		}
		var refused *refusedErr
		if errors.As(err, &refused) {
			remoteLogf("%v", err) // sending it again won't help
		} else if err != nil {
			spoolBatch(spool, b)
			return
		}
	}
	if !tryNow {
		return
	}
	ents, err := os.ReadDir(spool)
	if err != nil {
		return
	}
	names := make([]string, 0, len(ents))
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for i, n := range names {
		if i >= 10 || ctx.Err() != nil {
			return
		}
		p := filepath.Join(spool, n)
		old, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		err = postBatch(ctx, st, old)
		var refused *refusedErr
		if err == nil || errors.As(err, &refused) {
			os.Remove(p)
		} else {
			return
		}
	}
}

type refusedErr struct{ status string }

func (e *refusedErr) Error() string { return "control plane refused the batch: " + e.status }

var eventHTTP = &http.Client{}

func postBatch(ctx context.Context, st *cpclient.State, b []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, st.Server+"/ep/v1/events", bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+st.Secret)
	req.Header.Set("Content-Type", "application/json")
	res, err := eventHTTP.Do(req)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	res.Body.Close()
	switch {
	case res.StatusCode/100 == 2:
		return nil
	case res.StatusCode/100 == 4 && res.StatusCode != 408 && res.StatusCode != 429:
		return &refusedErr{res.Status}
	}
	return fmt.Errorf("events: %s", res.Status)
}

func spoolBatch(dir string, b []byte) {
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	if ents, err := os.ReadDir(dir); err == nil && len(ents) >= spoolMax {
		return // full: this batch is lost (the console shows the gap as silence)
	}
	sum := sha256.Sum256(b)
	name := fmt.Sprintf("%020d-%x.json", time.Now().UnixNano(), sum[:8])
	tmp := filepath.Join(dir, "."+name+".tmp")
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, filepath.Join(dir, name))
	}
}

// cloudSetupCmd implements `effigentd cloud-setup`, run once in a cloud
// environment's setup step: it saves the token's credentials in the state
// dir (so hooks that don't see the vendor's secrets still work) and fetches
// the policy, so the first tool call doesn't wait for the control plane.
func cloudSetupCmd(args []string) {
	fs := flag.NewFlagSet("cloud-setup", flag.ExitOnError)
	token := fs.String("token", os.Getenv("EFFIGENT_CLOUD_TOKEN"), "the cloud environment's token (efc_…; default $EFFIGENT_CLOUD_TOKEN)")
	dir := fs.String("state-dir", cloudStateDir(), "where the hooks find it (default $EFFIGENT_STATE_DIR or /var/tmp/effigent-cloud)")
	offline := fs.Bool("allow-offline", false, "succeed even if the control plane can't be reached now (the hooks then deny until it can)")
	shared := fs.Bool("shared", false, "let other users read the state (the agent runs as another user than this setup step)")
	_ = fs.Parse(args)
	st, err := stateFromToken(*token)
	if err != nil {
		fmt.Fprintln(os.Stderr, "effigentd cloud-setup:", err)
		os.Exit(2)
	}
	if err := os.MkdirAll(*dir, 0o700); err != nil {
		fmt.Fprintln(os.Stderr, "effigentd cloud-setup:", err)
		os.Exit(1)
	}
	b, _ := json.MarshalIndent(st, "", "  ")
	mode := os.FileMode(0o600)
	if *shared {
		// The agent may run as another user than the setup step; it can read the token anyway (docs/cloud-agents.md).
		mode = 0o644
		_ = os.Chmod(*dir, 0o755)
	}
	tmp := filepath.Join(*dir, ".endpoint.json.tmp")
	if err := os.WriteFile(tmp, b, mode); err == nil {
		err = os.Rename(tmp, filepath.Join(*dir, "endpoint.json"))
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "effigentd cloud-setup:", err)
		os.Exit(1)
	}
	pol, raw, _ := policy.Load("")
	eng := engine.New(pol, raw, nil, func(event.Event) {}, remoteLogf, false)
	client := &cpclient.Client{State: st, Dir: *dir, Logf: remoteLogf, AgentVersion: version,
		Apply: func(ctx context.Context, body []byte) error {
			_, err := eng.SetPolicy(ctx, body)
			return err
		}}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = client.LoadCached(ctx)
	if err := client.SyncOnce(ctx); err != nil || client.Version() == 0 {
		if err == nil {
			err = errors.New("the control plane has no policy for this environment yet (publish one in the console)")
		}
		fmt.Fprintf(os.Stderr, "effigentd cloud-setup: %s: %v\n", st.Server, err)
		if !*offline {
			os.Exit(1)
		}
		return
	}
	touch(filepath.Join(*dir, "synced"))
	if *shared {
		_ = os.Chmod(filepath.Join(*dir, "policy.json"), 0o644)
	}
	fmt.Printf("effigentd: cloud environment %s ready (policy v%d, state in %s)\n", st.EndpointID, client.Version(), *dir)
}
