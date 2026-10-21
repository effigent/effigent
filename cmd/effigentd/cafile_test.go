package main

import (
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// A control plane behind a private CA: unknown until the CA file is trusted,
// then reachable through every client that uses the default transport, and
// again on the next start from the copy enroll keeps in the state dir.
func TestTrustCAFile(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer srv.Close()
	t.Setenv("EFFIGENT_CA_FILE", "")
	orig := http.DefaultTransport
	defer func() { http.DefaultTransport = orig }()
	fresh := func() { http.DefaultTransport = orig.(*http.Transport).Clone() }
	get := func() error {
		res, err := (&http.Client{}).Get(srv.URL) // like cpclient's clients: no Transport of its own
		if err == nil {
			res.Body.Close()
		}
		return err
	}

	fresh()
	if err := get(); err == nil {
		t.Fatal("a private CA's server was trusted without a CA file")
	}
	dir := t.TempDir()
	ca := filepath.Join(dir, "corp-ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := trustCAFiles(ca); err != nil {
		t.Fatal(err)
	}
	if err := get(); err != nil {
		t.Fatalf("with the CA file: %v", err)
	}

	state := t.TempDir()
	if err := saveCA(ca, state); err != nil {
		t.Fatal(err)
	}
	fresh()
	if err := trustStateCA(state); err != nil {
		t.Fatal(err)
	}
	if err := get(); err != nil {
		t.Fatalf("from the state dir's copy: %v", err)
	}

	fresh()
	t.Setenv("EFFIGENT_CA_FILE", ca)
	if err := trustStateCA(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if err := get(); err != nil {
		t.Fatalf("from EFFIGENT_CA_FILE: %v", err)
	}

	bad := filepath.Join(dir, "bad.pem")
	_ = os.WriteFile(bad, []byte("not a certificate"), 0o600)
	if err := trustCAFiles(bad); err == nil {
		t.Fatal("a file without certificates accepted")
	}
	if err := trustCAFiles(filepath.Join(dir, "missing.pem")); err == nil {
		t.Fatal("a missing CA file accepted")
	}
}
