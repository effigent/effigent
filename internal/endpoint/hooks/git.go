package hooks

import (
	"os"
	"path"
	"slices"
	"strings"

	"github.com/effigent/effigent/internal/endpoint/event"
)

// defaultProtected is protected_branches when a policy names none.
var defaultProtected = []string{"main", "master", "trunk", "prod", "production", "release", "release/*", "release-*"}

func (x *actx) protected(branch string) bool {
	list := x.rule.ProtectedBranches
	if len(list) == 0 {
		list = defaultProtected
	}
	return slices.ContainsFunc(list, func(p string) bool { return wild(p, branch) })
}

// git classifies a git command: pushes (target branch, force, delete),
// branch deletes, discarded work, hook bypasses, core.hooksPath changes.
func (x *actx) git(args []string, env map[string]string) {
	dir := x.cwd
	i := 0
	for i < len(args) && strings.HasPrefix(args[i], "-") {
		switch a := args[i]; a {
		case "-C":
			if i+1 < len(args) {
				dir = resolveIn(args[i+1], dir, x.home)
			}
			i += 2
		case "-c":
			if i+1 < len(args) && strings.HasPrefix(strings.ToLower(args[i+1]), "core.hookspath") {
				x.add(event.Action{Kind: "hook_bypass", Target: "git -c " + args[i+1]})
			}
			i += 2
		case "--git-dir", "--work-tree", "--namespace", "--exec-path":
			i += 2
		default:
			i++
		}
	}
	if i >= len(args) {
		return
	}
	sub, rest := args[i], args[i+1:]
	switch sub {
	case "push":
		x.push(rest, dir)
	case "branch":
		if hasFlag(rest, "-d", "-D", "--delete") || shortFlag(rest, 'd') || shortFlag(rest, 'D') {
			for _, b := range positional(rest, nil) {
				x.add(event.Action{Kind: "branch_delete", Target: b, Attrs: map[string]string{"where": "local"}})
			}
		}
	case "reset":
		if hasFlag(rest, "--hard") {
			x.add(event.Action{Kind: "history_rewrite", Target: "git reset --hard"})
		}
	case "clean":
		if hasFlag(rest, "--force") || shortFlag(rest, 'f') {
			x.add(event.Action{Kind: "history_rewrite", Target: "git clean -f"})
		}
	case "filter-branch", "filter-repo":
		x.add(event.Action{Kind: "history_rewrite", Target: "git " + sub})
	case "stash":
		if len(rest) > 0 && (rest[0] == "drop" || rest[0] == "clear") {
			x.add(event.Action{Kind: "history_rewrite", Target: "git stash " + rest[0]})
		}
	case "commit", "merge", "rebase", "am", "cherry-pick", "revert":
		if hasFlag(rest, "--no-verify") || sub == "commit" && shortFlag(rest, 'n') {
			x.add(event.Action{Kind: "hook_bypass", Target: "git " + sub + " --no-verify"})
		}
	case "config":
		for _, a := range rest {
			if strings.EqualFold(a, "core.hooksPath") {
				x.add(event.Action{Kind: "guardrail_edit", Target: "git config core.hooksPath"})
			}
		}
	}
}

// push classifies `git push [opts] [remote [refspec…]]`.
func (x *actx) push(rest []string, dir string) {
	valued := map[string]bool{"-o": true, "--push-option": true, "--repo": true, "--receive-pack": true, "--exec": true}
	pos := positional(rest, valued)
	remote, refspecs := "", []string(nil)
	if len(pos) > 0 {
		remote, refspecs = pos[0], pos[1:]
	}
	force := hasFlag(rest, "--force", "--force-with-lease", "--force-if-includes", "--mirror") || shortFlag(rest, 'f')
	del := hasFlag(rest, "--delete") || shortFlag(rest, 'd')
	if hasFlag(rest, "--no-verify") {
		x.add(event.Action{Kind: "hook_bypass", Target: "git push --no-verify"})
	}
	type dest struct {
		branch   string
		inferred bool
		force    bool
		delete   bool
	}
	var dests []dest
	current := func() dest { return dest{branch: currentBranch(dir), inferred: true} }
	switch {
	case hasFlag(rest, "--all", "--branches", "--mirror"):
		dests = append(dests, dest{branch: "all branches"})
	case len(refspecs) == 0 && hasFlag(rest, "--tags"):
	case len(refspecs) == 0:
		dests = append(dests, current())
	}
	for _, r := range refspecs {
		d := dest{force: strings.HasPrefix(r, "+"), delete: strings.HasPrefix(r, ":")}
		r = strings.TrimPrefix(r, "+")
		src, dst, colon := strings.Cut(r, ":")
		if !colon {
			dst = src
		}
		if strings.HasPrefix(dst, "refs/tags/") {
			continue
		}
		dst = strings.TrimPrefix(dst, "refs/heads/")
		if dst == "HEAD" || dst == "@" {
			c := current()
			d.branch, d.inferred = c.branch, true
		} else {
			d.branch = dst
		}
		dests = append(dests, d)
	}
	for _, d := range dests {
		attrs := map[string]string{"remote": remote}
		if d.inferred {
			attrs["inferred"] = "current branch"
		}
		name := d.branch
		if name == "" {
			name = "the current branch (unknown)"
		}
		switch {
		case del || d.delete:
			x.add(event.Action{Kind: "branch_delete", Target: name, Attrs: withAttr(attrs, "where", "remote")})
			continue
		case force || d.force:
			x.add(event.Action{Kind: "force_push", Target: name, Attrs: attrs})
		}
		if d.branch == "all branches" || d.branch != "" && x.protected(d.branch) {
			x.add(event.Action{Kind: "protected_push", Target: name, Attrs: attrs})
		}
	}
}

func withAttr(m map[string]string, k, v string) map[string]string {
	out := map[string]string{k: v}
	for a, b := range m {
		out[a] = b
	}
	return out
}

// currentBranch reads the checked-out branch from .git/HEAD ("" if
// detached or not a repository). Worktrees' .git files are followed.
func currentBranch(dir string) string {
	for range maxWalk {
		g := path.Join(dir, ".git")
		if st, err := os.Stat(g); err == nil {
			if !st.IsDir() {
				b, err := os.ReadFile(g)
				if err != nil {
					return ""
				}
				gd, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir:")
				if !ok {
					return ""
				}
				g = strings.TrimSpace(gd)
				if !path.IsAbs(g) {
					g = path.Join(dir, g)
				}
			}
			head, err := os.ReadFile(path.Join(g, "HEAD"))
			if err != nil {
				return ""
			}
			ref, ok := strings.CutPrefix(strings.TrimSpace(string(head)), "ref: refs/heads/")
			if !ok {
				return ""
			}
			return ref
		}
		parent := path.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
	return ""
}

// gh: merging a pull request lands on its base branch; deleting a repository.
func (x *actx) gh(rest []string) {
	pos := positional(rest, map[string]bool{"-R": true, "--repo": true, "-t": true, "--subject": true, "-b": true, "--body": true})
	switch {
	case len(pos) >= 2 && pos[0] == "pr" && pos[1] == "merge":
		attrs := map[string]string{}
		if hasFlag(rest, "--admin") {
			attrs["admin"] = "bypasses branch protection"
		}
		x.add(event.Action{Kind: "protected_push", Target: "gh pr merge " + strings.Join(pos[2:], " "), Attrs: attrs})
	case len(pos) >= 2 && pos[0] == "repo" && (pos[1] == "delete" || pos[1] == "archive"):
		x.add(event.Action{Kind: "cloud_destroy", Target: "gh repo " + strings.Join(pos[1:], " ")})
	case len(pos) >= 2 && pos[0] == "release" && pos[1] == "delete":
		x.add(event.Action{Kind: "cloud_destroy", Target: "gh release " + strings.Join(pos[1:], " ")})
	case len(pos) >= 2 && (pos[0] == "secret" || pos[0] == "variable") && (pos[1] == "set" || pos[1] == "delete"):
		x.add(event.Action{Kind: "guardrail_edit", Target: "gh " + strings.Join(pos, " ")})
	}
}
