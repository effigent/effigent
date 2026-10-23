package hooks

import (
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
	pushDefault := "" // git -c push.default=…
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
			if i+1 < len(args) {
				if k, v, ok := strings.Cut(args[i+1], "="); ok && strings.EqualFold(k, "push.default") {
					pushDefault = strings.ToLower(v)
				}
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
		x.push(rest, dir, pushDefault)
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
func (x *actx) push(rest []string, dir, pushDefault string) {
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
	current := func() dest { return dest{branch: currentBranch(x.in, dir), inferred: true} }
	upstream := false
	switch {
	case hasFlag(rest, "--all", "--branches", "--mirror"):
		dests = append(dests, dest{branch: "all branches"})
	case len(refspecs) == 0 && hasFlag(rest, "--tags"):
	case len(refspecs) == 0:
		// no refspec: push.default decides where the current branch goes
		switch b, how := x.defaultPush(dir, pushDefault); how {
		case "nothing":
		case "matching":
			dests = append(dests, dest{branch: "all matching branches"})
		default:
			dests = append(dests, dest{branch: b, inferred: true})
			upstream = how == "upstream"
		}
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
			if upstream {
				attrs["inferred"] = "upstream of the current branch"
			}
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
		if d.branch == "all branches" || d.branch == "all matching branches" || d.branch != "" && x.protected(d.branch) {
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

// gitDir finds the repository's git directory from dir upward, following a
// worktree's .git file ("" if none, or not readable by the agent's user).
func gitDir(in ClaudeInput, dir string) string {
	for range maxWalk {
		g := path.Join(dir, ".git")
		if st, err := statIn(in, g); err == nil {
			if st.IsDir() {
				return g
			}
			gd, ok := strings.CutPrefix(strings.TrimSpace(readUserText(in, g)), "gitdir:")
			if !ok {
				return ""
			}
			g = strings.TrimSpace(gd)
			if !path.IsAbs(g) {
				g = path.Join(dir, g)
			}
			return g
		}
		parent := path.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
	return ""
}

// currentBranch reads the checked-out branch from .git/HEAD ("" if
// detached, not a repository, or not readable by the agent's user).
// Worktrees' .git files are followed.
func currentBranch(in ClaudeInput, dir string) string {
	g := gitDir(in, dir)
	if g == "" {
		return ""
	}
	ref, ok := strings.CutPrefix(strings.TrimSpace(readUserText(in, path.Join(g, "HEAD"))), "ref: refs/heads/")
	if !ok {
		return ""
	}
	return ref
}

// defaultPush is where `git push [remote]` with no refspec sends the current
// branch, by push.default (git -c, else the repository's config, else the
// user's): how is "nothing", "matching", "upstream" (branch.<name>.merge,
// which can name another branch) or "current" (the same name: simple, current,
// and upstream with no tracking branch).
func (x *actx) defaultPush(dir, override string) (branch, how string) {
	cur := currentBranch(x.in, dir)
	var cfgs []gitConfig
	if g := gitDir(x.in, dir); g != "" {
		common := g // a worktree's config lives in the main repository's git dir
		if c := strings.TrimSpace(readUserText(x.in, path.Join(g, "commondir"))); c != "" {
			common = c
			if !path.IsAbs(c) {
				common = path.Join(g, c)
			}
		}
		cfgs = append(cfgs, parseGitConfig(readUserText(x.in, path.Join(common, "config"))))
	}
	cfgs = append(cfgs, parseGitConfig(readUserText(x.in, x.home+"/.gitconfig")),
		parseGitConfig(readUserText(x.in, x.home+"/.config/git/config")))
	get := func(key string) string {
		for _, c := range cfgs {
			if v, ok := c[key]; ok {
				return v
			}
		}
		return ""
	}
	mode := override
	if mode == "" {
		mode = strings.ToLower(get("push.default"))
	}
	switch mode {
	case "nothing", "matching":
		return "", mode
	case "upstream", "tracking":
		if cur != "" {
			if m := strings.TrimPrefix(get("branch."+cur+".merge"), "refs/heads/"); m != "" {
				return m, "upstream"
			}
		}
	}
	return cur, "current"
}

// gitConfig is a git config file's values by section (lower case),
// subsection (as written) and name (lower case): "branch.feature/x.merge".
// The last value wins; includes aren't followed.
type gitConfig map[string]string

func parseGitConfig(text string) gitConfig {
	out := gitConfig{}
	section := ""
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line[0] == '#' || line[0] == ';' {
			continue
		}
		if line[0] == '[' {
			section = ""
			end := strings.LastIndexByte(line, ']')
			if end < 0 {
				continue
			}
			name, sub, ok := strings.Cut(strings.TrimSpace(line[1:end]), " ")
			if ok {
				section = strings.ToLower(name) + "." + strings.Trim(strings.TrimSpace(sub), `"`)
			} else if n, s, ok := strings.Cut(name, "."); ok { // [branch.main], the old form
				section = strings.ToLower(n) + "." + s
			} else {
				section = strings.ToLower(name)
			}
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if section == "" || !ok {
			continue
		}
		v = strings.TrimSpace(v)
		if strings.HasPrefix(v, `"`) {
			if e := strings.IndexByte(v[1:], '"'); e >= 0 {
				v = v[1 : e+1]
			}
		} else if c := strings.IndexAny(v, "#;"); c >= 0 {
			v = strings.TrimSpace(v[:c])
		}
		out[section+"."+strings.ToLower(strings.TrimSpace(k))] = v
	}
	return out
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
