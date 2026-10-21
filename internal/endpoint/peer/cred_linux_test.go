//go:build linux

package peer

import (
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestCred(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "s.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := net.Dial("unix", sock)
		if err == nil {
			defer c.Close()
			_, _ = io.ReadAll(c)
		}
	}()
	c, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	pid, uid, _, err := Cred(c)
	if err != nil {
		t.Fatal(err)
	}
	if pid != os.Getpid() || uid != os.Getuid() {
		t.Fatalf("got pid %d uid %d, want %d %d", pid, uid, os.Getpid(), os.Getuid())
	}
	if in := Resolve("/proc", pid, uid, 0, nil); in.Root != "" {
		t.Fatalf("own process has root %q", in.Root)
	}
}

// A container's absolute symlink must resolve inside the container, never
// to the daemon's (host's) file.
func TestOpenInStaysInRoot(t *testing.T) {
	root := t.TempDir()
	host := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(host, []byte("host"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "inside"), []byte("container"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(host, filepath.Join(root, "abs")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/inside", filepath.Join(root, "rel")); err != nil {
		t.Fatal(err)
	}
	if f, err := OpenIn(root, "/abs"); err == nil {
		b, _ := io.ReadAll(f)
		f.Close()
		t.Fatalf("absolute symlink escaped the root: read %q", b)
	}
	f, err := OpenIn(root, "/rel")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(f)
	f.Close()
	if string(b) != "container" {
		t.Fatalf("got %q", b)
	}
	if f, err := OpenIn(root, "/../../../"+host); err == nil {
		f.Close()
		t.Fatal(".. escaped the root")
	}
}
