package hooks

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"path"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/policy"
)

// Actions are what a tool call does beyond which programs run
// (policy.ActionKinds): a push to a protected branch, a DROP TABLE inside
// `psql -c` or a heredoc, a package install, a cloud deletion, a write to CI
// config. They are read from the command line, the scripts and files it
// names, and the agent's environment, never by running anything. The kernel
// sees none of this; only an agent hook can deny or pause on it.

// maxRead caps a file read to understand a command (a script, a .sql file).
const maxRead = 512 << 10

// maxScriptDepth is how deep scripts calling scripts are followed.
const maxScriptDepth = 2

// facts is what one canonical tool call does.
type facts struct {
	actions []event.Action
	writes  []string    // absolute paths the call writes
	pkgs    []pkgRef    // packages it installs by name or restores from a manifest
	cmds    []simpleCmd // Bash: the command line's simple commands, then its scripts'
	seen    Seen        // what the call adds to its session (session rules)
}

// actx classifies one canonical tool call.
type actx struct {
	rule policy.Rule
	in   ClaudeInput
	cwd  string
	home string
	from string // the script being read, for Action.In
	f    facts
	seen map[string]bool
}

func newActx(rule policy.Rule, in ClaudeInput) *actx {
	home := in.Home
	if home == "" {
		home = homeDir()
	}
	return &actx{rule: rule, in: in, cwd: in.Cwd, home: strings.ReplaceAll(home, `\`, "/"), seen: map[string]bool{}}
}

// classify returns what a canonical tool call does.
func classify(rule policy.Rule, in ClaudeInput) facts {
	x := newActx(rule, in)
	switch {
	case in.ToolName == "Bash":
		x.bash(str(in.ToolInput, "command"))
	case in.ToolName == "Write" || in.ToolName == "Edit" || in.ToolName == "MultiEdit" || in.ToolName == "NotebookEdit":
		for _, k := range []string{"file_path", "notebook_path"} {
			if p := str(in.ToolInput, k); p != "" {
				x.write(resolveIn(p, x.cwd, x.home))
			}
		}
	case in.ToolName == "Read" || in.ToolName == "NotebookRead":
		for _, k := range []string{"file_path", "notebook_path"} {
			if p := str(in.ToolInput, k); p != "" {
				x.credentialPath(resolveIn(p, x.cwd, x.home))
			}
		}
	case in.ToolName == "WebFetch":
		if u, err := url.Parse(str(in.ToolInput, "url")); err == nil && u.Hostname() != "" {
			x.hostAccess(strings.ToLower(u.Hostname()))
		}
	case strings.HasPrefix(in.ToolName, "mcp__"):
		x.mcp(in.ToolName, in.ToolInput)
	}
	x.model()
	x.lookupPackages()
	x.observe()
	return x.f
}

func (x *actx) add(a event.Action) {
	if a.In == "" {
		a.In = x.from
	}
	a.Target = clip(a.Target, 200)
	key := a.Kind + "\x00" + a.Target + "\x00" + a.In
	if x.seen[key] {
		return
	}
	x.seen[key] = true
	a.Envs = envsOf(x.rule.Environments, a)
	x.f.actions = append(x.f.actions, a)
}

// getenv reads a variable set in the command itself, else the agent's.
func (x *actx) getenv(env map[string]string, name string) string {
	if v, ok := env[name]; ok {
		return v
	}
	return x.in.Env[name]
}

// ---- reading files as the agent's user ----

var errSkip = errors.New("not read")

// readUserFile reads a small regular file the agent's OS user could read
// itself: effigentd runs as root, and a command naming a file must not make
// it read (and report from) a file the user can't. Symlinks are followed and
// the target checked.
func readUserFile(in ClaudeInput, p string) ([]byte, error) {
	if p == "" {
		return nil, errSkip
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > maxRead || !userCanRead(st, in) {
		return nil, errSkip
	}
	return io.ReadAll(io.LimitReader(f, maxRead))
}

func readUserText(in ClaudeInput, p string) string {
	b, err := readUserFile(in, p)
	if err != nil {
		return ""
	}
	return string(b)
}

// resolveIn is resolve with the agent user's home for ~.
func resolveIn(p, cwd, home string) string {
	p = strings.ReplaceAll(p, `\`, "/")
	for _, pre := range []string{"~", "$HOME", "${HOME}"} {
		if p == pre || strings.HasPrefix(p, pre+"/") {
			p = home + p[len(pre):]
			break
		}
	}
	return resolve(p, cwd)
}

// findUp returns the first dir/name walking up from dir ("" if none).
func findUp(dir, name string) string {
	for range maxWalk {
		p := path.Join(dir, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
		parent := path.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
	return ""
}

const maxWalk = 40

// ---- scripts ----

// expandScripts adds the commands of the scripts a command line runs: shell
// scripts (`bash x.sh`, `./x.sh`, `source x`) and package.json scripts
// (`npm run db:reset`, `npm test`). pipeFrom indices stay valid.
func expandScripts(cmds []simpleCmd, in ClaudeInput, cwd, home string, depth int) []simpleCmd {
	var out []simpleCmd
	pos := make([]int, len(cmds)) // where cmds[i] landed in out
	for i, c := range cmds {
		if c.pipeFrom > 0 && c.pipeFrom <= i {
			c.pipeFrom = pos[c.pipeFrom-1] + 1
		}
		pos[i] = len(out)
		out = append(out, c)
		if depth >= maxScriptDepth {
			continue
		}
		body, from := scriptOf(c, in, cwd, home)
		if body == "" {
			continue
		}
		sub := expandScripts(splitShell(body), in, cwd, home, depth+1)
		base := len(out)
		for j := range sub {
			if sub[j].pipeFrom > 0 {
				sub[j].pipeFrom += base
			}
			if sub[j].from == "" {
				sub[j].from = from
			}
		}
		out = append(out, sub...)
	}
	return out
}

var (
	scriptShells = map[string]bool{"sh": true, "bash": true, "zsh": true, "dash": true, "ksh": true}
	shebangRE    = regexp.MustCompile(`\b(ba|z|da|k)?sh\b`)
)

// scriptOf returns the script a command runs, and a label for it.
func scriptOf(c simpleCmd, in ClaudeInput, cwd, home string) (string, string) {
	args := program(c.args)
	if len(args) == 0 {
		return "", ""
	}
	name := progName(args[0])
	switch {
	case scriptShells[name]:
		if slicesHasDashC(args) {
			return "", "" // read by splitShell already
		}
		for _, a := range args[1:] {
			if !strings.HasPrefix(a, "-") {
				p := resolveIn(a, cwd, home)
				return readUserText(in, p), path.Base(p)
			}
		}
	case name == "source" || name == ".":
		if len(args) > 1 {
			p := resolveIn(args[1], cwd, home)
			return readUserText(in, p), path.Base(p)
		}
	case name == "npm" || name == "pnpm" || name == "yarn" || name == "bun":
		if s := npmScript(args); s != "" {
			return packageScript(in, cwd, name, s)
		}
	case strings.Contains(args[0], "/"):
		p := resolveIn(args[0], cwd, home)
		if strings.HasPrefix(p, "/usr/") || strings.HasPrefix(p, "/bin/") || strings.HasPrefix(p, "/sbin/") || strings.HasPrefix(p, "/opt/homebrew/") {
			return "", ""
		}
		body := readUserText(in, p)
		first, _, _ := strings.Cut(body, "\n")
		if strings.HasSuffix(p, ".sh") || strings.HasPrefix(first, "#!") && shebangRE.MatchString(first) {
			return body, path.Base(p)
		}
	}
	return "", ""
}

// npmScript is the package.json script an npm-family command runs ("" if none).
func npmScript(args []string) string {
	name := progName(args[0])
	pos := positional(args[1:], map[string]bool{"--prefix": true, "-C": true, "--dir": true, "--cwd": true, "--filter": true, "-w": true, "--workspace": true})
	if len(pos) == 0 {
		return ""
	}
	switch v := pos[0]; {
	case v == "run" || v == "run-script" || v == "rum" || v == "urn":
		if len(pos) > 1 {
			return pos[1]
		}
	case v == "test" || v == "t" || v == "tst":
		return "test"
	case v == "start" || v == "stop" || v == "restart":
		return v
	case name == "yarn" || name == "pnpm":
		// `yarn build` / `pnpm build` run a script when one has that name
		if !npmBuiltins[v] {
			return "?" + v
		}
	}
	return ""
}

var npmBuiltins = map[string]bool{
	"add": true, "install": true, "i": true, "remove": true, "rm": true, "up": true, "upgrade": true, "update": true,
	"dlx": true, "exec": true, "create": true, "init": true, "publish": true, "pack": true, "link": true, "unlink": true,
	"why": true, "list": true, "ls": true, "outdated": true, "audit": true, "info": true, "config": true, "cache": true,
	"login": true, "logout": true, "workspace": true, "workspaces": true, "set": true, "plugin": true, "dedupe": true,
	"import": true, "prune": true, "rebuild": true, "store": true, "env": true, "patch": true, "patch-commit": true,
	"global": true, "bin": true, "root": true, "licenses": true, "node": true, "version": true, "help": true, "-v": true,
}

// packageScript returns a package.json script (with its pre/post scripts).
// A name starting with "?" is used only if the script exists.
func packageScript(in ClaudeInput, cwd, mgr, name string) (string, string) {
	name = strings.TrimPrefix(name, "?")
	p := findUp(cwd, "package.json")
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if p == "" || json.Unmarshal([]byte(readUserText(in, p)), &pkg) != nil {
		return "", ""
	}
	body, ok := pkg.Scripts[name]
	if !ok {
		return "", ""
	}
	if mgr == "npm" {
		body = strings.Join(slices.DeleteFunc([]string{pkg.Scripts["pre"+name], body, pkg.Scripts["post"+name]},
			func(s string) bool { return s == "" }), "\n")
	}
	return body, "package.json script " + name
}

// positional returns the words that aren't flags, skipping the values of
// flags that take one.
func positional(args []string, valued map[string]bool) []string {
	var out []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			return append(out, args[i+1:]...)
		}
		if strings.HasPrefix(a, "-") && len(a) > 1 {
			if valued[a] {
				i++
			}
			continue
		}
		out = append(out, a)
	}
	return out
}

// flagValue returns the value of the first of names present: "--x v" or "--x=v".
func flagValue(args []string, names ...string) (string, bool) {
	for i, a := range args {
		if a == "--" {
			break
		}
		for _, n := range names {
			if a == n && i+1 < len(args) {
				return args[i+1], true
			}
			if v, ok := strings.CutPrefix(a, n+"="); ok && strings.HasPrefix(n, "--") {
				return v, true
			}
		}
	}
	return "", false
}

func hasFlag(args []string, names ...string) bool {
	for _, a := range args {
		if a == "--" {
			return false
		}
		if slices.Contains(names, a) {
			return true
		}
		for _, n := range names {
			if strings.HasPrefix(n, "--") && strings.HasPrefix(a, n+"=") {
				return true
			}
		}
	}
	return false
}

// shortFlag reports whether a cluster of short flags (-fu) holds letter c.
func shortFlag(args []string, c byte) bool {
	for _, a := range args {
		if a == "--" {
			return false
		}
		if len(a) > 1 && a[0] == '-' && a[1] != '-' && strings.IndexByte(a[1:], c) >= 0 && isLetters(a[1:]) {
			return true
		}
	}
	return false
}

func isLetters(s string) bool {
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return false
		}
	}
	return s != ""
}

// ---- environments ----

// envsOf names the environments an action's target belongs to.
func envsOf(envs map[string]policy.Environment, a event.Action) []string {
	if len(envs) == 0 || len(a.Attrs) == 0 {
		return nil
	}
	names := make([]string, 0, len(envs))
	for n := range envs {
		names = append(names, n)
	}
	sort.Strings(names)
	var out []string
	for _, n := range names {
		e := envs[n]
		in := func(key string, pats []string) bool {
			v := a.Attrs[key]
			return v != "" && slices.ContainsFunc(pats, func(p string) bool { return wild(p, v) })
		}
		host := func(key string) bool { return a.Attrs[key] != "" && hostMatches(e.Hosts, a.Attrs[key]) }
		if in("aws_profile", e.AWSProfiles) || in("aws_account", e.AWSAccounts) || in("kube_context", e.KubeContexts) ||
			in("gcloud_project", e.GCloudProjects) || in("azure_subscription", e.AzureSubscriptions) ||
			in("azure_subscription_name", e.AzureSubscriptions) || in("terraform_workspace", e.TerraformWorkspace) ||
			in("pulumi_stack", e.PulumiStacks) || in("mcp_server", e.MCPServers) || host("db_host") || host("host") ||
			e.MatchUnknown && a.Attrs["target"] == "unknown" {
			out = append(out, n)
		}
	}
	return out
}

// hostMatches matches a hostname or IP against names (with * wildcards), IPs and CIDRs.
func hostMatches(pats []string, h string) bool {
	h = strings.ToLower(strings.TrimSuffix(h, "."))
	ip := net.ParseIP(h)
	for _, p := range pats {
		p = strings.ToLower(strings.TrimSpace(p))
		if ip != nil && strings.Contains(p, "/") {
			if _, n, err := net.ParseCIDR(p); err == nil && n.Contains(ip) {
				return true
			}
			continue
		}
		if wild(p, h) {
			return true
		}
	}
	return false
}

// wild matches s against a pattern where * stands for any run of
// characters, ignoring case.
func wild(p, s string) bool {
	p, s = strings.ToLower(p), strings.ToLower(s)
	if !strings.Contains(p, "*") {
		return p == s
	}
	parts := strings.Split(p, "*")
	if !strings.HasPrefix(s, parts[0]) {
		return false
	}
	s = s[len(parts[0]):]
	for i, part := range parts[1:] {
		if i == len(parts)-2 {
			return strings.HasSuffix(s, part)
		}
		j := strings.Index(s, part)
		if j < 0 {
			return false
		}
		s = s[j+len(part):]
	}
	return true
}

// ---- matching policy lists ----

// matchActions returns the first list entry (kind or kind@env) covering an action.
func matchActions(list []string, acts []event.Action) (string, event.Action, bool) {
	for _, e := range list {
		kind, env, _ := strings.Cut(e, "@")
		for _, a := range acts {
			if policy.KindCovers(kind, a.Kind) && (env == "" || slices.Contains(a.Envs, env)) {
				return e, a, true
			}
		}
	}
	return "", event.Action{}, false
}

// listsName reports whether any actions list names one of kinds.
func listsName(r policy.Rule, kinds ...string) bool {
	for _, e := range append(slices.Clone(r.ActionsDeny), r.ActionsApprove...) {
		k, _, _ := strings.Cut(e, "@")
		if slices.Contains(kinds, k) {
			return true
		}
	}
	return false
}

// kindLabel says what an action kind is in a sentence.
var kindLabel = map[string]string{
	"protected_push":       "pushing to a protected branch",
	"force_push":           "force-pushing",
	"branch_delete":        "deleting a branch",
	"history_rewrite":      "discarding git history or uncommitted work",
	"hook_bypass":          "skipping git hooks",
	"destructive_sql":      "a destructive database statement",
	"sql_write":            "changing a database",
	"cloud_change":         "changing cloud or cluster resources",
	"cloud_destroy":        "deleting cloud or cluster resources",
	"access":               "reaching this target",
	"package_install":      "installing packages",
	"package_unlisted":     "a package outside the approved list",
	"package_registry":     "installing from an unapproved registry or source",
	"package_scripts":      "running package install scripts (use --ignore-scripts)",
	"package_malicious":    "a package known to be malicious",
	"package_vulnerable":   "a package version with a known vulnerability",
	"guardrail_edit":       "changing CI config, git hooks, agent settings or startup files",
	"credential_read":      "reading credentials or secrets",
	"remote_script":        "running a downloaded script",
	"fs_destroy":           "deleting a directory tree",
	"mcp_unlisted":         "an MCP server that isn't approved",
	"model_endpoint":       "an unapproved model API endpoint",
	"model_api_key":        "a personal model API key",
	"mcp_changed":          "an MCP server whose definition changed since it was pinned",
	"exfil_sequence":       "sending data to a new host after reading credentials",
	"untrusted_then_risky": "a risky action after reading outside content",
}

// describe is an action in a reason: "force-pushing (main, prod)".
func describe(a event.Action, entry string) string {
	s := kindLabel[a.Kind]
	var bits []string
	if a.Target != "" {
		bits = append(bits, clip(a.Target, 80))
	}
	if _, env, ok := strings.Cut(entry, "@"); ok {
		bits = append(bits, "on "+env)
	}
	if a.In != "" {
		bits = append(bits, "in "+a.In)
	}
	if len(bits) > 0 {
		s += " (" + strings.Join(bits, ", ") + ")"
	}
	return s
}
