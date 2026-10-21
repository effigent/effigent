// Package ident works out who is behind an agent's action: the OS user a
// kernel uid belongs to, and the git identity (user.email) that user commits
// with in the agent's working directory. Both feed the control plane's people
// mapping (Pricing Leaks); neither changes what is enforced.
//
// Git config is read from the files, never by running git: effigentd runs as
// root, and running git inside a repository the user controls would let that
// repository's config run commands (core.fsmonitor, aliases…) as root.
package ident

import (
	"bufio"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	cacheTTL   = 10 * time.Minute
	maxEntries = 2048
	maxWalk    = 40 // directories walked up looking for a repository
)

type entry struct {
	v  string
	at time.Time
}

// Resolver caches lookups; the zero value is not usable, use New.
type Resolver struct {
	mu    sync.Mutex
	users map[uint32]entry
	homes map[string]entry
	git   map[string]entry // home + "\x00" + cwd
	now   func() time.Time
	// lookups, replaceable in tests
	lookupID   func(uid string) (*user.User, error)
	lookupName func(name string) (*user.User, error)
}

func New() *Resolver {
	return &Resolver{users: map[uint32]entry{}, homes: map[string]entry{}, git: map[string]entry{},
		now: time.Now, lookupID: user.LookupId, lookupName: user.Lookup}
}

// Default is the process-wide resolver.
var Default = New()

func (r *Resolver) fresh(e entry, ok bool) bool { return ok && r.now().Sub(e.at) < cacheTTL }

func prune[K comparable](m map[K]entry) {
	if len(m) >= maxEntries {
		clear(m) // simple and bounded; entries are cheap to recompute
	}
}

// OSUser is the user name of a uid on this machine ("" if unknown).
func (r *Resolver) OSUser(uid uint32) string {
	r.mu.Lock()
	e, ok := r.users[uid]
	r.mu.Unlock()
	if r.fresh(e, ok) {
		return e.v
	}
	name := ""
	if u, err := r.lookupID(strconv.FormatUint(uint64(uid), 10)); err == nil {
		name = u.Username
	}
	r.mu.Lock()
	prune(r.users)
	r.users[uid] = entry{name, r.now()}
	r.mu.Unlock()
	return name
}

func (r *Resolver) home(name string) string {
	h, _, _ := r.Account(name)
	return h
}

// Account is an OS user's home directory and uid (ok false if unknown).
func (r *Resolver) Account(name string) (home string, uid int, ok bool) {
	r.mu.Lock()
	e, hit := r.homes[name]
	r.mu.Unlock()
	if !r.fresh(e, hit) {
		v := ""
		if u, err := r.lookupName(name); err == nil {
			v = u.Uid + "\x00" + u.HomeDir
		}
		r.mu.Lock()
		prune(r.homes)
		e = entry{v, r.now()}
		r.homes[name] = e
		r.mu.Unlock()
	}
	id, h, found := strings.Cut(e.v, "\x00")
	if !found {
		return "", 0, false
	}
	n, err := strconv.Atoi(id)
	return h, n, err == nil
}

// GitEmail is the user.email git would use for osUser in cwd: the
// repository's config, else the user's global config ("" if none).
// Includes and conditional includes are not followed (best effort).
func (r *Resolver) GitEmail(osUser, cwd string) string {
	if osUser == "" && cwd == "" {
		return ""
	}
	home := ""
	if osUser != "" {
		home = r.home(osUser)
	}
	key := home + "\x00" + cwd
	r.mu.Lock()
	e, ok := r.git[key]
	r.mu.Unlock()
	if r.fresh(e, ok) {
		return e.v
	}
	v := ""
	if cwd != "" && filepath.IsAbs(cwd) {
		if cfg := repoConfig(cwd); cfg != "" {
			v = configEmail(cfg)
		}
	}
	if v == "" && home != "" {
		v = configEmail(filepath.Join(home, ".gitconfig"))
		if v == "" {
			xdg := filepath.Join(home, ".config", "git", "config")
			v = configEmail(xdg)
		}
	}
	r.mu.Lock()
	prune(r.git)
	r.git[key] = entry{v, r.now()}
	r.mu.Unlock()
	return v
}

// repoConfig finds the config file of the repository containing dir.
func repoConfig(dir string) string {
	d := filepath.Clean(dir)
	for i := 0; i < maxWalk; i++ {
		g := filepath.Join(d, ".git")
		if st, err := os.Stat(g); err == nil {
			if st.IsDir() {
				return filepath.Join(g, "config")
			}
			// a worktree or submodule: ".git" is a file "gitdir: <path>"
			if b, err := os.ReadFile(g); err == nil && len(b) < 4096 {
				s := strings.TrimSpace(string(b))
				if p, ok := strings.CutPrefix(s, "gitdir:"); ok {
					p = strings.TrimSpace(p)
					if !filepath.IsAbs(p) {
						p = filepath.Join(d, p)
					}
					// a linked worktree's own dir has "commondir" pointing at the main repo
					if c, err := os.ReadFile(filepath.Join(p, "commondir")); err == nil {
						cd := strings.TrimSpace(string(c))
						if !filepath.IsAbs(cd) {
							cd = filepath.Join(p, cd)
						}
						return filepath.Join(cd, "config")
					}
					return filepath.Join(p, "config")
				}
			}
			return ""
		}
		parent := filepath.Dir(d)
		if parent == d {
			return ""
		}
		d = parent
	}
	return ""
}

// configEmail reads user.email from one git config file ("" if unset).
// The last value wins, as in git.
func configEmail(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || st.Size() > 1<<20 {
		return ""
	}
	inUser, email := false, ""
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || line[0] == '#' || line[0] == ';' {
			continue
		}
		if line[0] == '[' {
			end := strings.IndexByte(line, ']')
			if end < 0 {
				continue
			}
			sect := strings.ToLower(strings.TrimSpace(line[1:end]))
			inUser = sect == "user"
			line = strings.TrimSpace(line[end+1:]) // "[user] email = x" on one line
			if line == "" {
				continue
			}
		}
		if !inUser {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || !strings.EqualFold(strings.TrimSpace(k), "email") {
			continue
		}
		v = strings.TrimSpace(v)
		if i := strings.IndexAny(v, "#;"); i >= 0 && !strings.HasPrefix(v, "\"") {
			v = strings.TrimSpace(v[:i])
		}
		v = strings.Trim(v, "\"")
		if strings.Contains(v, "@") && len(v) <= 254 {
			email = strings.ToLower(v)
		}
	}
	return email
}
