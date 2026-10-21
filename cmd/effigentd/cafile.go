package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
)

// A self-hosted control plane may use a certificate from a private CA.
// EFFIGENT_CA_FILE (or `enroll --ca-file`) adds a PEM bundle to the system
// roots for every connection effigentd makes; `enroll` keeps a copy in the
// state dir (ca.pem), which the daemon trusts on every start, so a restart
// without the variable still reaches the control plane. The system roots stay
// trusted. On macOS this is the only way: Go ignores SSL_CERT_FILE there.

const caFileName = "ca.pem"

// trustCAFiles adds the PEM certificates in each path to the system roots
// and installs them on http.DefaultTransport (all of effigentd's HTTP
// clients use it). Empty paths are skipped; none at all changes nothing.
func trustCAFiles(paths ...string) error {
	var pool *x509.CertPool
	for _, path := range paths {
		if path == "" {
			continue
		}
		pem, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("CA file: %w", err)
		}
		if pool == nil {
			if pool, err = x509.SystemCertPool(); err != nil || pool == nil {
				pool = x509.NewCertPool()
			}
		}
		if !pool.AppendCertsFromPEM(pem) {
			return fmt.Errorf("CA file %s: no PEM certificates in it", path)
		}
	}
	if pool == nil {
		return nil
	}
	t, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return errors.New("CA file: unexpected default transport")
	}
	if t.TLSClientConfig == nil {
		t.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	} else {
		t.TLSClientConfig = t.TLSClientConfig.Clone()
	}
	t.TLSClientConfig.RootCAs = pool
	return nil
}

// trustStateCA trusts the bundle `enroll --ca-file` saved, if any, and
// EFFIGENT_CA_FILE.
func trustStateCA(stateDir string) error {
	saved := filepath.Join(stateDir, caFileName)
	if _, err := os.Stat(saved); err != nil {
		saved = ""
	}
	return trustCAFiles(saved, os.Getenv("EFFIGENT_CA_FILE"))
}

// saveCA copies the bundle into the state dir (root-only, like the credentials).
func saveCA(path, stateDir string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(stateDir, caFileName), b, 0o600)
}
