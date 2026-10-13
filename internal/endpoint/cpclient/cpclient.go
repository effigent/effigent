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
	host, _ := os.Hostname()
	body, _ := json.Marshal(map[string]any{"token": token, "info": map[string]string{
		"hostname": host, "os": runtime.GOOS, "arch": runtime.GOARCH, "version": version}})
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
		return nil, fmt.Errorf("enroll: %s: %s", res.Status, strings.TrimSpace(string(msg)))
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
	if err := os.WriteFile(statePath(dir), b, 0o600); err != nil {
		return nil, err
	}
	return st, nil
}

// Client syncs policy for an enrolled endpoint.
type Client struct {
	State   *State
	Dir     string
	Apply   func(ctx context.Context, body []byte) error // hot-applies a policy body
	OnApply func(version int64)
	Logf    func(string, ...any)

	pub     ed25519.PublicKey
	current int64
	http    *http.Client
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
		b, _ := json.Marshal(d)
		_ = os.WriteFile(policyPath(c.Dir), b, 0o600)
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

// SyncOnce fetches the newest policy (if any) and heartbeats.
func (c *Client) SyncOnce(ctx context.Context) error {
	if err := c.init(); err != nil {
		return err
	}
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
	hb, err := c.do(ctx, http.MethodPost, "/ep/v1/heartbeat", map[string]int64{"policy_version": c.current})
	if err != nil {
		return err
	}
	hb.Body.Close()
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
