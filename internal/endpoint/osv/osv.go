// Package osv looks packages up in OSV (https://osv.dev): known
// vulnerabilities, and OpenSSF's malicious-packages feed (MAL- ids).
//
// Lookups fail open: an unreachable or slow OSV is an error the caller
// records, never a block. Answers are cached for an hour.
package osv

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Pkg is a package, version optional. Ecosystem is effigent's name
// (npm, pypi, cargo, go, gem).
type Pkg struct {
	Ecosystem string
	Name      string
	Version   string
}

func (p Pkg) key() string { return p.Ecosystem + "|" + p.Name + "|" + p.Version }

// Finding is what OSV knows about one package.
type Finding struct {
	Pkg
	Malicious  []string // MAL- ids that apply (every version when Version is empty)
	Vulnerable []string // other advisory ids affecting Version (only when Version is set)
}

// ecosystems maps effigent's names to OSV's.
var ecosystems = map[string]string{"npm": "npm", "pypi": "PyPI", "cargo": "crates.io", "go": "Go", "gem": "RubyGems"}

// Supported reports whether OSV covers an ecosystem.
func Supported(eco string) bool { return ecosystems[eco] != "" }

// Client queries OSV.
type Client struct {
	BaseURL string // https://api.osv.dev
	HTTP    *http.Client
	TTL     time.Duration

	mu    sync.Mutex
	cache map[string]entry
}

type entry struct {
	f   Finding
	exp time.Time
}

// Default is the client effigentd uses.
var Default = &Client{BaseURL: "https://api.osv.dev", HTTP: &http.Client{Timeout: 4 * time.Second}, TTL: time.Hour}

// maxBatch is OSV's querybatch limit.
const maxBatch = 1000

// Lookup returns a finding for every package OSV covers (others are left
// out). Cached answers are used; the rest go in one querybatch call, and
// MAL- advisories for an unversioned package are fetched to see whether
// they cover every version.
func (c *Client) Lookup(ctx context.Context, pkgs []Pkg) ([]Finding, error) {
	var out []Finding
	var ask []Pkg
	now := time.Now()
	c.mu.Lock()
	for _, p := range pkgs {
		if !Supported(p.Ecosystem) {
			continue
		}
		if e, ok := c.cache[p.key()]; ok && now.Before(e.exp) {
			out = append(out, e.f)
			continue
		}
		ask = append(ask, p)
	}
	c.mu.Unlock()
	if len(ask) > maxBatch {
		ask = ask[:maxBatch]
	}
	if len(ask) == 0 {
		return out, nil
	}
	ids, err := c.queryBatch(ctx, ask)
	if err != nil {
		return out, err
	}
	var firstErr error
	for i, p := range ask {
		f := Finding{Pkg: p}
		for _, id := range ids[i] {
			switch {
			case strings.HasPrefix(id, "MAL-") && p.Version == "":
				all, err := c.coversAll(ctx, id, p)
				if err != nil {
					firstErr = err
					continue
				}
				if all {
					f.Malicious = append(f.Malicious, id)
				}
			case strings.HasPrefix(id, "MAL-"):
				f.Malicious = append(f.Malicious, id)
			case p.Version != "":
				f.Vulnerable = append(f.Vulnerable, id)
			}
		}
		out = append(out, f)
		c.put(f)
	}
	return out, firstErr
}

func (c *Client) put(f Finding) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cache == nil {
		c.cache = map[string]entry{}
	}
	if len(c.cache) > 20000 {
		c.cache = map[string]entry{}
	}
	ttl := c.TTL
	if ttl == 0 {
		ttl = time.Hour
	}
	c.cache[f.key()] = entry{f: f, exp: time.Now().Add(ttl)}
}

type query struct {
	Package struct {
		Name      string `json:"name"`
		Ecosystem string `json:"ecosystem"`
	} `json:"package"`
	Version string `json:"version,omitempty"`
}

// queryBatch returns the advisory ids for each package, in order.
func (c *Client) queryBatch(ctx context.Context, pkgs []Pkg) ([][]string, error) {
	var body struct {
		Queries []query `json:"queries"`
	}
	for _, p := range pkgs {
		var q query
		q.Package.Name, q.Package.Ecosystem, q.Version = p.Name, ecosystems[p.Ecosystem], p.Version
		body.Queries = append(body.Queries, q)
	}
	var resp struct {
		Results []struct {
			Vulns []struct {
				ID string `json:"id"`
			} `json:"vulns"`
		} `json:"results"`
	}
	if err := c.do(ctx, http.MethodPost, "/v1/querybatch", body, &resp); err != nil {
		return nil, err
	}
	if len(resp.Results) != len(pkgs) {
		return nil, fmt.Errorf("osv: %d results for %d queries", len(resp.Results), len(pkgs))
	}
	out := make([][]string, len(pkgs))
	for i, r := range resp.Results {
		for _, v := range r.Vulns {
			out[i] = append(out[i], v.ID)
		}
	}
	return out, nil
}

// coversAll reports whether an advisory affects every version of p: a
// range introduced at 0 with nothing fixed or last affected.
func (c *Client) coversAll(ctx context.Context, id string, p Pkg) (bool, error) {
	var v struct {
		Affected []struct {
			Package struct {
				Name      string `json:"name"`
				Ecosystem string `json:"ecosystem"`
			} `json:"package"`
			Ranges []struct {
				Events []map[string]string `json:"events"`
			} `json:"ranges"`
			Versions []string `json:"versions"`
		} `json:"affected"`
	}
	if err := c.do(ctx, http.MethodGet, "/v1/vulns/"+id, nil, &v); err != nil {
		return false, err
	}
	for _, a := range v.Affected {
		if !strings.EqualFold(a.Package.Name, p.Name) || a.Package.Ecosystem != ecosystems[p.Ecosystem] {
			continue
		}
		if len(a.Ranges) == 0 && len(a.Versions) == 0 {
			return true, nil
		}
		for _, r := range a.Ranges {
			from0, bounded := false, false
			for _, e := range r.Events {
				if e["introduced"] == "0" {
					from0 = true
				}
				if e["fixed"] != "" || e["last_affected"] != "" || e["limit"] != "" {
					bounded = true
				}
			}
			if from0 && !bounded {
				return true, nil
			}
		}
	}
	return false, nil
}

func (c *Client) do(ctx context.Context, method, p string, in, out any) error {
	var rd *bytes.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimSuffix(c.BaseURL, "/")+p, rd)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	res, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("osv: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("osv: %s %s: %s", method, p, res.Status)
	}
	return json.NewDecoder(res.Body).Decode(out)
}
