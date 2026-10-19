package ident

import (
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"testing"
	"time"
)

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestGitEmail(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home", "dana")
	write(t, filepath.Join(home, ".gitconfig"), "[core]\n\teditor = vim\n[user]\n\tname = Dana\n\temail = Dana@Personal.dev # personal\n")
	// a work repository overrides the global email
	write(t, filepath.Join(root, "src", "work", ".git", "config"), "[remote \"origin\"]\n\turl = x\n[user]\n\temail = \"dana@acme.io\"\n")
	// a linked worktree: .git is a file, its gitdir has commondir
	wt := filepath.Join(root, "src", "work", ".git", "worktrees", "feat")
	write(t, filepath.Join(wt, "commondir"), "../..\n")
	write(t, filepath.Join(root, "src", "feat", ".git"), "gitdir: "+wt+"\n")
	// a repository without a user section
	write(t, filepath.Join(root, "src", "oss", ".git", "config"), "[core]\n\tbare = false\n")

	r := New()
	r.lookupName = func(name string) (*user.User, error) {
		if name == "dana" {
			return &user.User{Username: "dana", HomeDir: home}, nil
		}
		return nil, errors.New("unknown user")
	}
	cases := []struct{ user, cwd, want string }{
		{"dana", filepath.Join(root, "src", "work", "cmd", "x"), "dana@acme.io"},
		{"dana", filepath.Join(root, "src", "feat"), "dana@acme.io"},
		{"dana", filepath.Join(root, "src", "oss"), "dana@personal.dev"},
		{"dana", filepath.Join(root, "tmp"), "dana@personal.dev"},
		{"nobody", filepath.Join(root, "tmp"), ""},
		{"", filepath.Join(root, "src", "work"), "dana@acme.io"},
		{"dana", "relative/path", "dana@personal.dev"},
	}
	for _, c := range cases {
		if got := r.GitEmail(c.user, c.cwd); got != c.want {
			t.Errorf("GitEmail(%q, %q) = %q, want %q", c.user, c.cwd, got, c.want)
		}
	}
}

func TestConfigEmailInline(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config")
	write(t, p, "[user] email = a@x.io\n[user]\n  email = b@x.io\n[other]\n  email = c@x.io\n")
	if got := configEmail(p); got != "b@x.io" {
		t.Fatalf("got %q", got)
	}
}

func TestOSUserCached(t *testing.T) {
	r := New()
	calls := 0
	r.lookupID = func(uid string) (*user.User, error) {
		calls++
		if uid == "501" {
			return &user.User{Username: "dana"}, nil
		}
		return nil, errors.New("no such user")
	}
	now := time.Unix(1_800_000_000, 0)
	r.now = func() time.Time { return now }
	if r.OSUser(501) != "dana" || r.OSUser(501) != "dana" || r.OSUser(7) != "" {
		t.Fatal("lookup")
	}
	if calls != 2 {
		t.Fatalf("%d lookups, want 2 (cached)", calls)
	}
	now = now.Add(cacheTTL + time.Second)
	r.OSUser(501)
	if calls != 3 {
		t.Fatal("stale entry not refreshed")
	}
}
