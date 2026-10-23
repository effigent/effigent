package hooks

import (
	"maps"
	"path"
	"regexp"
	"slices"
	"strings"

	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/policy"
)

// bash classifies a shell command line, the scripts it runs included.
func (x *actx) bash(line string) {
	cmds := expandScripts(splitShell(line), x.in, x.cwd, x.home, 0)
	x.f.cmds = cmds
	vars := map[string]string{} // A=b and export A=b, for the rest of the line
	for i, c := range cmds {
		x.from = c.from
		args, wrappers := unwrap(c.args)
		env := maps.Clone(vars)
		for _, w := range c.args[:len(c.args)-len(args)] {
			if k, v, ok := strings.Cut(w, "="); ok && isAssignment(w) {
				env[k] = v
			}
		}
		if len(args) == 0 {
			if len(wrappers) > 0 && progName(wrappers[len(wrappers)-1]) == "env" {
				x.add(event.Action{Kind: "credential_read", Target: "env (the whole environment)"})
			} else if len(wrappers) == 0 {
				maps.Copy(vars, env) // plain assignments
			}
			continue
		}
		if progName(args[0]) == "export" {
			for _, w := range args[1:] {
				if k, v, ok := strings.Cut(w, "="); ok && isAssignment(w) {
					vars[k] = v
				}
			}
			if len(args) == 1 || args[1] == "-p" {
				x.add(event.Action{Kind: "credential_read", Target: "export (the whole environment)"})
			}
			continue
		}
		x.command(cmds, i, args, env)
		x.files(c, args)
	}
	x.from = ""
	x.remoteScripts(line, cmds)
}

// command classifies one simple command (args[0] is the program).
func (x *actx) command(cmds []simpleCmd, i int, args []string, env map[string]string) {
	prog := progName(args[0])
	rest := args[1:]
	switch {
	case prog == "git":
		x.git(rest, env)
	case prog == "gh":
		x.gh(rest)
	case cloudCLIs[prog]:
		x.cloud(prog, rest, env)
	case prog == "docker" || prog == "podman" || prog == "nerdctl":
		if inner := containerExec(rest); len(inner) > 0 {
			x.command(withArgs(cmds, i, inner), i, inner, env)
		}
	case dbClients[prog]:
		x.sql(cmds, i, prog, rest, env)
	case prog == "rm" || prog == "find":
		x.destroy(prog, rest, env)
	case prog == "crontab":
		if !hasFlag(rest, "-l") {
			x.add(event.Action{Kind: "guardrail_edit", Target: "crontab"})
		}
	case prog == "launchctl":
		if len(rest) > 0 && slices.Contains([]string{"load", "bootstrap", "enable", "submit"}, rest[0]) {
			x.add(event.Action{Kind: "guardrail_edit", Target: "launchctl " + strings.Join(rest, " ")})
		}
	case prog == "systemctl":
		if p := positional(rest, nil); len(p) > 0 && (p[0] == "enable" || p[0] == "link" || p[0] == "edit") {
			x.add(event.Action{Kind: "guardrail_edit", Target: "systemctl " + strings.Join(rest, " ")})
		}
	}
	line := strings.TrimSpace(prog + " " + strings.Join(rest, " "))
	x.migration(line, env)
	x.credentialCommand(prog, rest, line)
	x.packages(cmds, i, prog, rest, env)
	if prog == "git" && (env["HUSKY"] == "0" || env["SKIP_HOOKS"] != "" || env["SKIP"] != "") {
		x.add(event.Action{Kind: "hook_bypass", Target: "git hooks disabled by environment"})
	}
}

// withArgs is cmds with command i's words replaced (a container exec's inner command).
func withArgs(cmds []simpleCmd, i int, args []string) []simpleCmd {
	out := slices.Clone(cmds)
	out[i].args = args
	return out
}

// containerExec returns the command `docker exec [opts] container cmd…`
// (and compose exec) runs, nil if none.
func containerExec(args []string) []string {
	if len(args) > 0 && args[0] == "compose" {
		args = args[1:]
		for len(args) > 0 && strings.HasPrefix(args[0], "-") {
			if args[0] == "-f" || args[0] == "--file" || args[0] == "-p" || args[0] == "--project-name" {
				args = args[1:]
			}
			args = args[1:]
		}
	}
	if len(args) == 0 || args[0] != "exec" && args[0] != "run" {
		return nil
	}
	valued := map[string]bool{"-e": true, "--env": true, "-u": true, "--user": true, "-w": true, "--workdir": true,
		"--env-file": true, "--name": true, "-v": true, "--volume": true, "--entrypoint": true, "-p": true, "--network": true}
	args = args[1:]
	for len(args) > 0 && strings.HasPrefix(args[0], "-") {
		if valued[args[0]] {
			args = args[1:]
		}
		args = args[1:]
	}
	if len(args) < 2 {
		return nil
	}
	return args[1:] // past the container / service / image
}

// files classifies the paths a command reads and writes: credentials,
// guarded files, write lists.
func (x *actx) files(c simpleCmd, args []string) {
	prog := progName(args[0])
	rest := args[1:]
	for _, w := range append(slices.Clone(rest), c.inputs...) {
		if strings.HasPrefix(w, "-") {
			if _, v, ok := strings.Cut(w, "="); ok {
				w = v
			} else {
				continue
			}
		}
		x.credentialPath(resolveIn(w, x.cwd, x.home))
		if h := hostIn(w); h != "" && !strings.Contains(w, "=") {
			x.hostAccess(h)
		}
	}
	for _, w := range rest {
		for _, m := range secretRefRE.FindAllStringSubmatch(w, -1) {
			x.add(event.Action{Kind: "credential_read", Target: "$" + m[1]})
		}
	}
	for _, p := range writeTargets(c, prog, rest) {
		x.write(resolveIn(p, x.cwd, x.home))
	}
}

var secretRefRE = regexp.MustCompile(`\$\{?([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Za-z0-9_]*)\}?`)

// writeTargets are the files a command writes: output redirects, and the
// targets of tee, cp, mv, sed -i, rm, curl -o…
func writeTargets(c simpleCmd, prog string, rest []string) []string {
	var out []string
	in := slices.Clone(c.inputs)
	for _, r := range c.redirects {
		if k := slices.Index(in, r); k >= 0 {
			in = slices.Delete(in, k, k+1)
			continue
		}
		out = append(out, r)
	}
	pos := positional(rest, map[string]bool{"-t": true, "--target-directory": true, "-e": true, "-m": true, "--mode": true,
		"-o": true, "-O": true, "--output": true, "-S": true, "--suffix": true})
	switch prog {
	case "tee", "mv", "rm", "rmdir", "unlink", "shred", "truncate", "touch", "chmod", "chown", "chgrp", "mkdir":
		out = append(out, pos...)
	case "cp", "ln", "install", "rsync", "scp":
		if t, ok := flagValue(rest, "-t", "--target-directory"); ok {
			out = append(out, t)
		} else if len(pos) > 1 {
			out = append(out, pos[len(pos)-1])
		}
	case "sed", "perl", "gsed":
		if shortFlag(rest, 'i') || hasFlag(rest, "--in-place") || slices.ContainsFunc(rest, func(a string) bool { return strings.HasPrefix(a, "-i") }) {
			out = append(out, pos...)
		}
	case "curl":
		if v, ok := flagValue(rest, "-o", "--output"); ok {
			out = append(out, v)
		}
	case "wget":
		if v, ok := flagValue(rest, "-O", "--output-document"); ok {
			out = append(out, v)
		}
	case "dd":
		for _, a := range rest {
			if v, ok := strings.CutPrefix(a, "of="); ok {
				out = append(out, v)
			}
		}
	}
	return out
}

// write records a path the call writes, and guardrail_edit for guarded ones.
func (x *actx) write(p string) {
	if p == "" || p == "/dev/null" || strings.HasPrefix(p, "/dev/") {
		return
	}
	x.f.writes = append(x.f.writes, p)
	if guardedPath(p) {
		x.add(event.Action{Kind: "guardrail_edit", Target: p})
	}
}

// guardedPath: files that configure CI, code review, git hooks, the agents
// themselves (and their hooks), shell startup, scheduled jobs and services:
// an agent editing these can remove its own guardrails or persist.
func guardedPath(p string) bool {
	l := strings.ToLower(p)
	base := path.Base(l)
	for _, s := range []string{"/.github/workflows/", "/.github/actions/", "/.circleci/", "/.buildkite/", "/.husky/",
		"/.git/hooks/", "/.claude/hooks/", "/library/launchagents/", "/library/launchdaemons/", "/.config/systemd/",
		"/.config/autostart/", "/library/application support/claudecode/", "/library/application support/geminicli/",
		"/etc/claude-code/", "/etc/codex/", "/etc/gemini-cli/", "/etc/cursor/", "/var/lib/effigent/", "/var/spool/cron/"} {
		if strings.Contains(l+"/", s) {
			return true
		}
	}
	for _, pre := range []string{"/etc/cron", "/etc/systemd/", "/etc/sudoers", "/etc/profile", "/etc/zsh", "/etc/bash",
		"/etc/launchd", "/etc/rc.", "/etc/init.d/"} {
		if strings.HasPrefix(l, pre) {
			return true
		}
	}
	switch base {
	case "codeowners", "jenkinsfile", ".gitlab-ci.yml", ".gitlab-ci.yaml", ".pre-commit-config.yaml", ".pre-commit-config.yml",
		"azure-pipelines.yml", "bitbucket-pipelines.yml", ".travis.yml", ".bashrc", ".zshrc", ".zshenv", ".zprofile",
		".profile", ".bash_profile", ".bash_login", ".npmrc", ".yarnrc.yml", "pip.conf", ".pypirc":
		return true
	}
	for _, s := range []string{"/.git/config", "/.claude/settings.json", "/.claude/settings.local.json", "/.claude.json",
		"/.codex/config.toml", "/.codex/requirements.toml", "/.gemini/settings.json", "/.cursor/hooks.json", "/.cursor/mcp.json",
		"/.config/fish/config.fish", "/.mcp.json"} {
		if strings.HasSuffix(l, s) {
			return true
		}
	}
	return false
}

// credentialPath records reading a credential file or cache.
func (x *actx) credentialPath(p string) {
	if p != "" && credentialFile(p) {
		x.add(event.Action{Kind: "credential_read", Target: p})
	}
}

var envFileRE = regexp.MustCompile(`/\.env(\.[\w.-]+)?$`)

func credentialFile(p string) bool {
	l := strings.ToLower(p)
	for _, s := range []string{"/.aws/credentials", "/.aws/sso/cache/", "/.aws/cli/cache/", "/.azure/", "/.config/gcloud/credentials",
		"/.config/gcloud/application_default_credentials", "/.config/gcloud/legacy_credentials/", "/.config/gcloud/access_tokens",
		"/.kube/config", "/.docker/config.json", "/.npmrc", "/.pypirc", "/.netrc", "/.git-credentials", "/.config/gh/hosts.yml",
		"/.terraform.d/credentials.tfrc.json", "/.vault-token", "/.config/op/", "/library/keychains/", "/.local/share/keyrings/",
		"/.gnupg/private-keys", "/etc/shadow", "/.pgpass", "/.my.cnf", "/environ"} {
		if strings.Contains(l+"/", s) && !(s == "/environ" && !strings.HasPrefix(l, "/proc/")) {
			return true
		}
	}
	if strings.Contains(l, "/.ssh/id_") && !strings.HasSuffix(l, ".pub") {
		return true
	}
	if m := envFileRE.FindStringSubmatch(l); m != nil {
		switch m[1] {
		case ".example", ".sample", ".template", ".dist", ".defaults":
			return false
		}
		return true
	}
	return strings.HasSuffix(l, ".pem") || strings.HasSuffix(l, ".p12") || strings.HasSuffix(l, ".pfx") || strings.HasSuffix(l, ".key")
}

// credentialCommand: commands that print a token, a secret store or the environment.
func (x *actx) credentialCommand(prog string, rest []string, line string) {
	switch {
	case prog == "printenv" || prog == "set" && len(rest) == 0 || prog == "declare" && hasFlag(rest, "-x", "-p"):
		if prog == "printenv" && len(rest) > 0 {
			if secretName(rest[0]) {
				x.add(event.Action{Kind: "credential_read", Target: "printenv " + rest[0]})
			}
			return
		}
		x.add(event.Action{Kind: "credential_read", Target: prog + " (the whole environment)"})
		return
	}
	for _, re := range credentialCommands {
		if re.MatchString(line) {
			x.add(event.Action{Kind: "credential_read", Target: clip(line, 80)})
			return
		}
	}
}

func secretName(n string) bool { return secretRefRE.MatchString("$" + n) }

var credentialCommands = []*regexp.Regexp{
	regexp.MustCompile(`^gh auth (token|status --show-token)`),
	regexp.MustCompile(`^aws (configure (get|export-credentials)|sts (get-session-token|assume-role)|ecr get-login-password|secretsmanager get-secret-value|ssm get-parameters?\b.*--with-decryption)`),
	regexp.MustCompile(`^gcloud (auth (print-access-token|print-identity-token|application-default print-access-token)|secrets versions access)`),
	regexp.MustCompile(`^az (account get-access-token|keyvault secret show)`),
	regexp.MustCompile(`^security (find-generic-password|find-internet-password|dump-keychain)`),
	regexp.MustCompile(`^(vault (read|kv get)|op (read|item get)|doppler secrets|bw get|pass show)\b`),
	regexp.MustCompile(`^kubectl get secrets?\b.*(-o|--output)`),
	// credential helpers: git's (fill asks every configured helper) and Docker's
	regexp.MustCompile(`^git (?:-[cC] \S+ |--[\w-]+(?:=\S+)? )*credential(?: fill|-[\w.-]+ get)\b`),
	regexp.MustCompile(`^git-credential-[\w.-]+ get\b`),
	regexp.MustCompile(`^docker-credential-[\w.-]+ (get|list)\b`),
}

// remoteScripts: a downloaded script run straight away.
func (x *actx) remoteScripts(line string, cmds []simpleCmd) {
	for _, c := range cmds {
		args := program(c.args)
		if len(args) == 0 || c.pipeFrom == 0 || c.pipeFrom > len(cmds) {
			continue
		}
		if !interpreters[progName(args[0])] || len(positional(args[1:], nil)) > 0 && progName(args[0]) != "sudo" {
			continue
		}
		src := program(cmds[c.pipeFrom-1].args)
		if len(src) > 0 && downloaders[progName(src[0])] {
			x.from = c.from
			x.add(event.Action{Kind: "remote_script", Target: clip(strings.Join(src, " ")+" | "+progName(args[0]), 160)})
		}
	}
	if m := procSubstRE.FindString(line); m != "" {
		x.add(event.Action{Kind: "remote_script", Target: clip(m, 160)})
	}
	for _, c := range cmds {
		args := program(c.args)
		if len(args) > 1 && scriptShells[progName(args[0])] && slicesHasDashC(args) {
			for _, a := range args[1:] {
				if downloadSubstRE.MatchString(a) {
					x.add(event.Action{Kind: "remote_script", Target: clip(a, 160)})
				}
			}
		}
	}
	x.from = ""
}

var (
	interpreters    = map[string]bool{"sh": true, "bash": true, "zsh": true, "dash": true, "ksh": true, "fish": true, "python": true, "python3": true, "node": true, "perl": true, "ruby": true, "iex": true, "invoke-expression": true, "pwsh": true, "powershell": true}
	downloaders     = map[string]bool{"curl": true, "wget": true, "fetch": true, "http": true, "https": true, "iwr": true, "invoke-webrequest": true, "irm": true, "invoke-restmethod": true, "aria2c": true}
	procSubstRE     = regexp.MustCompile(`(?:\b(?:ba|z|da|k)?sh|\bsource|(?:^|\s)\.)\s+<\(\s*(?:curl|wget)\b[^)]*\)`)
	downloadSubstRE = regexp.MustCompile(`\$\(\s*(?:curl|wget)\b`)
)

// destroy: recursive deletes outside build output and temp directories.
func (x *actx) destroy(prog string, rest []string, env map[string]string) {
	if prog == "find" {
		if hasFlag(rest, "-delete") || slices.Contains(rest, "-exec") && slices.Contains(rest, "rm") {
			if p := positional(rest, nil); len(p) > 0 && !scratch(p[0]) {
				x.add(event.Action{Kind: "fs_destroy", Target: "find " + p[0] + " … -delete"})
			}
		}
		return
	}
	if !hasFlag(rest, "--recursive") && !shortFlag(rest, 'r') && !shortFlag(rest, 'R') {
		return
	}
	var risky []string
	for _, t := range positional(rest, nil) {
		t, ok := expandVars(t, env, x.in.Env)
		if !ok {
			continue // an unresolved target claims nothing
		}
		if !scratch(resolveIn(t, x.cwd, x.home)) {
			risky = append(risky, t)
		}
	}
	if len(risky) > 0 {
		x.add(event.Action{Kind: "fs_destroy", Target: "rm -r " + strings.Join(risky[:min(3, len(risky))], " ")})
	}
}

var varRE = regexp.MustCompile(`\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?`)

// expandVars substitutes $VAR from the command's assignments; ok is false
// when any variable or substitution is unknown.
func expandVars(w string, env, agent map[string]string) (string, bool) {
	if strings.Contains(w, "$(") || strings.Contains(w, "`") {
		return w, false
	}
	ok := true
	out := varRE.ReplaceAllStringFunc(w, func(m string) string {
		n := varRE.FindStringSubmatch(m)[1]
		if v, has := env[n]; has {
			return v
		}
		if v, has := agent[n]; has && v != "set" {
			return v
		}
		if n == "TMPDIR" {
			return "/tmp"
		}
		ok = false
		return m
	})
	return out, ok
}

var buildOutput = map[string]bool{
	"node_modules": true, "dist": true, "build": true, "out": true, ".next": true, ".nuxt": true, ".svelte-kit": true,
	"coverage": true, ".turbo": true, ".cache": true, ".parcel-cache": true, "target": true, "__pycache__": true,
	".pytest_cache": true, ".mypy_cache": true, ".venv": true, "venv": true, "tmp": true, "temp": true, ".tmp": true,
	"storybook-static": true, ".vercel": true, ".serverless": true, ".aws-sam": true, ".gradle": true, "bin": false,
}

// scratch: build output and temp directories, where recursive deletes are routine.
func scratch(t string) bool {
	t = strings.TrimSuffix(strings.TrimSuffix(t, "/*"), "/")
	for _, pre := range []string{"/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", "/var/tmp/"} {
		if strings.HasPrefix(t+"/", pre) && t+"/" != pre {
			return true
		}
	}
	if strings.Contains(t, "/scratchpad/") {
		return true
	}
	base := path.Base(t)
	return buildOutput[base] || strings.HasSuffix(base, ".log") || strings.HasSuffix(base, ".tmp") || strings.HasPrefix(base, "tmp")
}

// hostAccess records reaching a named host (for access@env).
func (x *actx) hostAccess(h string) {
	if h == "" || h == "localhost" || strings.HasPrefix(h, "127.") {
		return
	}
	if len(x.rule.Environments) == 0 || !anyEnvHost(x.rule.Environments, h) {
		return // only worth an action when an environment names it
	}
	x.add(event.Action{Kind: "access", Target: h, Attrs: map[string]string{"host": h}})
}

func anyEnvHost(envs map[string]policy.Environment, h string) bool {
	for _, e := range envs {
		if hostMatches(e.Hosts, h) {
			return true
		}
	}
	return false
}
