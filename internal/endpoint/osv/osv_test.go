package osv

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync/atomic"
	"testing"
)

func TestLookup(t *testing.T) {
	var batches atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/querybatch":
			batches.Add(1)
			var in struct {
				Queries []query `json:"queries"`
			}
			_ = json.NewDecoder(r.Body).Decode(&in)
			type vuln struct {
				ID string `json:"id"`
			}
			var res []map[string][]vuln
			for _, q := range in.Queries {
				switch {
				case q.Package.Name == "evil-pkg":
					res = append(res, map[string][]vuln{"vulns": {{"MAL-1"}}})
				case q.Package.Name == "chalk" && q.Version == "":
					res = append(res, map[string][]vuln{"vulns": {{"MAL-2"}, {"GHSA-1"}}}) // compromised versions only
				case q.Package.Name == "chalk" && q.Version == "5.6.1":
					res = append(res, map[string][]vuln{"vulns": {{"MAL-2"}}})
				case q.Package.Name == "requests" && q.Package.Ecosystem == "PyPI" && q.Version == "2.19.0":
					res = append(res, map[string][]vuln{"vulns": {{"GHSA-2"}}})
				default:
					res = append(res, map[string][]vuln{})
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"results": res})
		case "/v1/vulns/MAL-1":
			_, _ = w.Write([]byte(`{"affected":[{"package":{"name":"evil-pkg","ecosystem":"npm"},"ranges":[{"type":"SEMVER","events":[{"introduced":"0"}]}]}]}`))
		case "/v1/vulns/MAL-2":
			_, _ = w.Write([]byte(`{"affected":[{"package":{"name":"chalk","ecosystem":"npm"},"versions":["5.6.1"]}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, HTTP: srv.Client()}
	pkgs := []Pkg{{"npm", "evil-pkg", ""}, {"npm", "chalk", ""}, {"npm", "chalk", "5.6.1"}, {"pypi", "requests", "2.19.0"}, {"brew", "wget", ""}}
	got, err := c.Lookup(context.Background(), pkgs)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Fatalf("brew is not covered: %+v", got)
	}
	by := map[string]Finding{}
	for _, f := range got {
		by[f.key()] = f
	}
	if !slices.Equal(by["npm|evil-pkg|"].Malicious, []string{"MAL-1"}) {
		t.Errorf("whole-package malicious: %+v", by["npm|evil-pkg|"])
	}
	if f := by["npm|chalk|"]; len(f.Malicious)+len(f.Vulnerable) != 0 {
		t.Errorf("unversioned chalk flagged for some versions: %+v", f)
	}
	if !slices.Equal(by["npm|chalk|5.6.1"].Malicious, []string{"MAL-2"}) {
		t.Errorf("compromised version: %+v", by["npm|chalk|5.6.1"])
	}
	if !slices.Equal(by["pypi|requests|2.19.0"].Vulnerable, []string{"GHSA-2"}) {
		t.Errorf("vulnerable pin: %+v", by["pypi|requests|2.19.0"])
	}
	if _, err := c.Lookup(context.Background(), pkgs); err != nil || batches.Load() != 1 {
		t.Errorf("cache: %d batches, %v", batches.Load(), err)
	}

	down := &Client{BaseURL: "http://127.0.0.1:1", HTTP: srv.Client()}
	if _, err := down.Lookup(context.Background(), pkgs[:1]); err == nil {
		t.Error("unreachable OSV is an error")
	}
}
