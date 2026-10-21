// Package cpclient connects an enrolled effigentd to the control plane:
// enrollment, signed policy sync (with an on-disk cache so enforcement keeps
// working offline), and heartbeats.
package cpclient

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/shared/sign"
)

// State is what enrollment leaves on disk (mode 0600).
type State struct {
	Server          string `json:"server"`
	EndpointID      string `json:"endpoint_id"`
	Secret          string `json:"secret"`
	Tenant          string `json:"tenant"`
	ServerPublicKey string `json:"server_public_key"`
}

func statePath(dir string) string  { return filepath.Join(dir, "endpoint.json") }
func policyPath(dir string) string { return filepath.Join(dir, "policy.json") }

// DefaultStateDir is where a system install keeps its enrollment:
// /var/lib/effigent (Linux), /Library/Application Support/Effigent (macOS),
// %ProgramData%\Effigent (Windows). Non-root runs on Unix use ~/.effigent.
func DefaultStateDir() string {
	switch runtime.GOOS {
	case "windows":
		pd := os.Getenv("ProgramData")
		if pd == "" {
			pd = `C:\ProgramData`
		}
		return filepath.Join(pd, "Effigent")
	case "darwin":
		if os.Geteuid() == 0 {
			return "/Library/Application Support/Effigent"
		}
	default:
		if os.Geteuid() == 0 {
			return "/var/lib/effigent"
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".effigent")
}

// DefaultServer is the hosted control plane.
const DefaultServer = "https://api.effigent.ai"

// MachineName is the name this endpoint enrolls and reports events under:
// $EFFIGENT_HOSTNAME when set (in Kubernetes the node's name, since a pod's own
// hostname is the pod's), else the OS hostname.
func MachineName() string {
	if h := strings.TrimSpace(os.Getenv("EFFIGENT_HOSTNAME")); h != "" {
		return h
	}
	h, _ := os.Hostname()
	return h
}

func LoadState(dir string) (*State, error) {
	b, err := os.ReadFile(statePath(dir))
	if err != nil {
		return nil, err
	}
	var s State
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// Enroll exchanges a one-time enrollment token for endpoint credentials.
func Enroll(ctx context.Context, server, token, dir, version string) (*State, error) {
	body, _ := json.Marshal(map[string]any{"token": token, "info": map[string]string{
		"hostname": MachineName(), "os": runtime.GOOS, "arch": runtime.GOARCH, "version": version}})
	server = strings.TrimSuffix(server, "/")
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, server+"/ep/v1/enroll", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return nil, &EnrollError{Status: res.StatusCode, Msg: fmt.Sprintf("enroll: %s: %s", res.Status, strings.TrimSpace(string(msg)))}
	}
	var out struct {
		EndpointID      string `json:"endpoint_id"`
		Secret          string `json:"secret"`
		Tenant          string `json:"tenant"`
		ServerPublicKey string `json:"server_public_key"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	st := &State{Server: server, EndpointID: out.EndpointID, Secret: out.Secret, Tenant: out.Tenant, ServerPublicKey: out.ServerPublicKey}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	b, _ := json.MarshalIndent(st, "", "  ")
	// Write-then-rename: a crash mid-write must not leave a half file that
	// makes the next start look unenrolled (and spend another token use).
	tmp := statePath(dir) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, statePath(dir)); err != nil {
		return nil, err
	}
	return st, nil
}

// EnrollError is the control plane refusing an enrollment (bad, expired or
// used-up token); retrying the same token won't help.
type EnrollError struct {
	Status int
	Msg    string
}

func (e *EnrollError) Error() string { return e.Msg }

// EnsureEnrolled returns the enrollment saved in dir, enrolling with token
// first when there is none (containers pass EFFIGENT_ENROLL_TOKEN). Saved
// credentials always win, so a restarted pod that keeps its state dir stays the
// same machine and never spends another token use. Network errors and 5xx are
// retried until ctx ends; a refused token is not. enrolled reports whether this
// call enrolled.
func EnsureEnrolled(ctx context.Context, server, token, dir, version string, logf func(string, ...any)) (st *State, enrolled bool, err error) {
	st, err = LoadState(dir)
	if err == nil {
		return st, false, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, false, fmt.Errorf("%s: %w", statePath(dir), err)
	}
	if token == "" {
		return nil, false, nil
	}
	for wait := 2 * time.Second; ; wait = min(2*wait, 30*time.Second) {
		st, err = Enroll(ctx, server, token, dir, version)
		var refused *EnrollError
		if err == nil || (errors.As(err, &refused) && refused.Status < 500) {
			return st, err == nil, err
		}
		logf("enroll with %s: %v (retrying in %s)", server, err, wait)
		select {
		case <-ctx.Done():
			return nil, false, err
		case <-time.After(wait):
		}
	}
}

// Client syncs policy for an enrolled endpoint.
type Client struct {
	State   *State
	Dir     string
	Apply   func(ctx context.Context, body []byte) error // hot-applies a policy body
	OnApply func(version int64)
	Logf    func(string, ...any)
	// AgentVersion is this effigentd build, reported with each heartbeat.
	AgentVersion string
	// Hooks, when set, reads the agents' hook state (hookstate.Check). It
	// runs at most every HooksEvery (default 1 min) and goes out with the
	// next heartbeat only when it differs from what the control plane last
	// acknowledged (every restart sends it once).
	Hooks      func() any
	HooksEvery time.Duration

	pub       ed25519.PublicKey
	current   int64
	http      *http.Client
	hooksAt   time.Time
	hooksNow  []byte
	hooksSent []byte
}

func (c *Client) init() error {
	if c.pub != nil {
		return nil
	}
	pub, err := sign.DecodePublic(c.State.ServerPublicKey)
	if err != nil {
		return err
	}
	c.pub, c.http = pub, &http.Client{Timeout: 15 * time.Second}
	return nil
}

func (c *Client) Version() int64 { return c.current }

// LoadCached applies the last verified policy from disk, so a restart while
// the control plane is unreachable still enforces the last known policy.
func (c *Client) LoadCached(ctx context.Context) error {
	if err := c.init(); err != nil {
		return err
	}
	b, err := os.ReadFile(policyPath(c.Dir))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var d sign.Document
	if err := json.Unmarshal(b, &d); err != nil {
		return err
	}
	return c.accept(ctx, d, false)
}

// accept verifies and applies a document; it refuses older or equal versions.
func (c *Client) accept(ctx context.Context, d sign.Document, persist bool) error {
	if err := sign.Verify(c.pub, c.State.Tenant, d); err != nil {
		return err
	}
	if d.Endpoint != "" && d.Endpoint != c.State.EndpointID {
		return fmt.Errorf("policy v%d was compiled for endpoint %s, this is %s", d.Version, d.Endpoint, c.State.EndpointID)
	}
	if d.Version <= c.current {
		return fmt.Errorf("refusing policy v%d: already running v%d", d.Version, c.current)
	}
	if err := c.Apply(ctx, []byte(d.Body)); err != nil {
		return fmt.Errorf("apply v%d: %w", d.Version, err)
	}
	c.current = d.Version
	if persist {
		// Write-then-rename: remote hooks (one process per tool call) read
		// this file while another call may be replacing it.
		b, _ := json.Marshal(d)
		if f, err := os.CreateTemp(c.Dir, ".policy-*.tmp"); err == nil {
			_, werr := f.Write(b)
			if cerr := f.Close(); werr == nil && cerr == nil && os.Chmod(f.Name(), 0o600) == nil {
				_ = os.Rename(f.Name(), policyPath(c.Dir))
			}
			os.Remove(f.Name()) // gone after a rename; left behind by a failed write
		}
	}
	if c.OnApply != nil {
		c.OnApply(d.Version)
	}
	return nil
}

func (c *Client) do(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequestWithContext(ctx, method, c.State.Server+path, rd)
	req.Header.Set("Authorization", "Bearer "+c.State.Secret)
	req.Header.Set("Content-Type", "application/json")
	return c.http.Do(req)
}

// SyncOnce fetches the newest policy (if any) and heartbeats. The heartbeat
// goes out even when the policy can't be fetched or applied (a machine
// whose compile fails is still online, and the control plane says so).
func (c *Client) SyncOnce(ctx context.Context) error {
	if err := c.init(); err != nil {
		return err
	}
	perr := c.syncPolicy(ctx)
	if ctx.Err() != nil {
		return perr
	}
	if err := c.heartbeat(ctx); err != nil && perr == nil {
		return err
	}
	return perr
}

func (c *Client) syncPolicy(ctx context.Context) error {
	res, err := c.do(ctx, http.MethodGet, fmt.Sprintf("/ep/v1/policy?have=%d", c.current), nil)
	if err != nil {
		return err
	}
	switch res.StatusCode {
	case http.StatusNoContent:
		res.Body.Close()
	case http.StatusOK:
		var d sign.Document
		err := json.NewDecoder(res.Body).Decode(&d)
		res.Body.Close()
		if err != nil {
			return err
		}
		if err := c.accept(ctx, d, true); err != nil {
			return err
		}
	default:
		res.Body.Close()
		return fmt.Errorf("policy: %s", res.Status)
	}
	return nil
}

func (c *Client) heartbeat(ctx context.Context) error {
	body := map[string]any{"policy_version": c.current, "version": c.AgentVersion}
	if c.Hooks != nil {
		every := c.HooksEvery
		if every <= 0 {
			every = time.Minute
		}
		if c.hooksNow == nil || time.Since(c.hooksAt) >= every {
			c.hooksAt = time.Now()
			if b, err := json.Marshal(c.Hooks()); err == nil {
				c.hooksNow = b
			}
		}
		if c.hooksNow != nil && !bytes.Equal(c.hooksNow, c.hooksSent) {
			body["hooks"] = json.RawMessage(c.hooksNow)
		}
	}
	hb, err := c.do(ctx, http.MethodPost, "/ep/v1/heartbeat", body)
	if err != nil {
		return err
	}
	hb.Body.Close()
	if hb.StatusCode/100 != 2 {
		return fmt.Errorf("heartbeat: %s", hb.Status)
	}
	if h, ok := body["hooks"].(json.RawMessage); ok {
		c.hooksSent = h
	}
	return nil
}

// Run syncs every interval until ctx is done.
func (c *Client) Run(ctx context.Context, interval time.Duration) {
	for {
		if err := c.SyncOnce(ctx); err != nil && ctx.Err() == nil {
			c.Logf("control plane sync: %v (still enforcing policy v%d)", err, c.current)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}
