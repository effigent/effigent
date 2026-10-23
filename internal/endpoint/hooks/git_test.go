package hooks

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/effigent/effigent/internal/endpoint/policy"
)

// A push with no refspec goes where push.default says: with upstream, a
// branch tracking a differently named one lands on that one.
func TestPushDefault(t *testing.T) {
	write := func(t *testing.T, root string, files map[string]string) {
		t.Helper()
		for p, body := range files {
			full := filepath.Join(root, p)
			if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	tracking := "[core]\n\tbare = false\n[branch \"feature/x\"]\n\tremote = origin\n\tmerge = refs/heads/main\n"
	cases := []struct {
		name  string
		files map[string]string // under a fresh home; the repo is home/repo
		cwd   string            // relative to home
		cmd   string
		want  []string
		not   []string
	}{
		{"upstream in repo config", map[string]string{
			"repo/.git/HEAD":   "ref: refs/heads/feature/x\n",
			"repo/.git/config": "[push]\n\tdefault = upstream ; set by grok-bot\n" + tracking,
		}, "repo", "git push", []string{"protected_push main"}, nil},
		{"upstream, explicit remote", map[string]string{
			"repo/.git/HEAD":   "ref: refs/heads/feature/x\n",
			"repo/.git/config": "[push]\n\tdefault = tracking\n" + tracking,
		}, "repo", "git push origin", []string{"protected_push main"}, nil},
		{"upstream from the user's gitconfig", map[string]string{
			"repo/.git/HEAD":   "ref: refs/heads/feature/x\n",
			"repo/.git/config": tracking,
			".gitconfig":       "[user]\n\tname = grok-bot\n[push]\n\tdefault = \"upstream\"\n",
		}, "repo", "git push", []string{"protected_push main"}, nil},
		{"repo config beats the user's", map[string]string{
			"repo/.git/HEAD":   "ref: refs/heads/feature/x\n",
			"repo/.git/config": "[push]\n\tdefault = simple\n" + tracking,
			".gitconfig":       "[push]\n\tdefault = upstream\n",
		}, "repo", "git push", nil, []string{"protected_push"}},
		{"simple (default) pushes the same name", map[string]string{
			"repo/.git/HEAD":   "ref: refs/heads/feature/x\n",
			"repo/.git/config": tracking,
		}, "repo", "git push", nil, []string{"protected_push"}},
		{"git -c overrides config", map[string]string{
			"repo/.git/HEAD":   "ref: refs/heads/feature/x\n",
			"repo/.git/config": "[push]\n\tdefault = upstream\n" + tracking,
		}, "repo", "git -c push.default=current push", nil, []string{"protected_push"}},
		{"git -c sets upstream", map[string]string{
			"repo/.git/HEAD":   "ref: refs/heads/feature/x\n",
			"repo/.git/config": tracking,
		}, "repo", "git -c push.default=upstream push", []string{"protected_push main"}, nil},
		{"refspec wins over upstream", map[string]string{
			"repo/.git/HEAD":   "ref: refs/heads/feature/x\n",
			"repo/.git/config": "[push]\n\tdefault = upstream\n" + tracking,
		}, "repo", "git push origin feature/x", nil, []string{"protected_push"}},
		{"HEAD refspec is the same name", map[string]string{
			"repo/.git/HEAD":   "ref: refs/heads/feature/x\n",
			"repo/.git/config": "[push]\n\tdefault = upstream\n" + tracking,
		}, "repo", "git push origin HEAD", nil, []string{"protected_push"}},
		{"upstream without tracking: same name", map[string]string{
			"repo/.git/HEAD":   "ref: refs/heads/main\n",
			"repo/.git/config": "[push]\n\tdefault = upstream\n",
		}, "repo", "git push", []string{"protected_push main"}, nil},
		{"matching may push protected branches", map[string]string{
			"repo/.git/HEAD":   "ref: refs/heads/feature/x\n",
			"repo/.git/config": "[push]\n\tdefault = matching\n",
		}, "repo", "git push", []string{"protected_push all matching branches"}, nil},
		{"nothing pushes nothing", map[string]string{
			"repo/.git/HEAD":   "ref: refs/heads/main\n",
			"repo/.git/config": "[push]\n\tdefault = nothing\n",
		}, "repo", "git push", nil, []string{"protected_push"}},
		{"worktree reads the main repository's config", map[string]string{
			"repo/.git/HEAD":                   "ref: refs/heads/other\n",
			"repo/.git/config":                 "[push]\n\tdefault = upstream\n" + tracking,
			"repo/.git/worktrees/wt/HEAD":      "ref: refs/heads/feature/x\n",
			"repo/.git/worktrees/wt/commondir": "../..\n",
			"wt/.git":                          "gitdir: ../repo/.git/worktrees/wt\n",
		}, "wt", "git push", []string{"protected_push main"}, nil},
		{"old-style [branch.name] section", map[string]string{
			"repo/.git/HEAD":   "ref: refs/heads/dev\n",
			"repo/.git/config": "[push]\n\tdefault = upstream\n[branch.dev]\n\tmerge = refs/heads/production\n",
		}, "repo", "git push", []string{"protected_push production"}, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			home := t.TempDir()
			write(t, home, c.files)
			in := ClaudeInput{ToolName: "Bash", Cwd: filepath.Join(home, c.cwd), Home: home, ToolInput: map[string]any{"command": c.cmd}}
			got := kinds(classify(policy.Rule{Mode: policy.Denylist}, in).actions)
			for _, w := range c.want {
				if !slices.ContainsFunc(got, func(g string) bool { return strings.HasPrefix(g, w) }) {
					t.Errorf("missing %q in %q", w, got)
				}
			}
			for _, n := range c.not {
				if slices.ContainsFunc(got, func(g string) bool { return strings.Contains(g, n) }) {
					t.Errorf("unexpected %q in %q", n, got)
				}
			}
		})
	}
}

func TestParseGitConfig(t *testing.T) {
	c := parseGitConfig("# comment\n[Push]\n\tDefault = upstream # trailing\n[branch \"Feature/X\"]\n\tmerge = \"refs/heads/main\"\n[remote \"origin\"]\n\turl = git@example.com:a/b.git\n")
	if c["push.default"] != "upstream" || c["branch.Feature/X.merge"] != "refs/heads/main" || c["remote.origin.url"] != "git@example.com:a/b.git" {
		t.Errorf("%v", c)
	}
}
