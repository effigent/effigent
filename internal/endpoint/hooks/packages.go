package hooks

import (
	"bufio"
	"context"
	"encoding/json"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/effigent/effigent/internal/endpoint/event"
	"github.com/effigent/effigent/internal/endpoint/osv"
)

// pkgRef is a package a call installs, by name or from a manifest.
type pkgRef struct {
	eco, name, version string
	manifest           string // the manifest or lockfile it came from, "" if named on the command line
}

func (p pkgRef) String() string {
	s := p.eco + ":" + p.name
	if p.version != "" {
		s += "@" + p.version
	}
	return s
}

// PackageLookup asks OSV about packages; effigentd's tests replace it.
var PackageLookup = osv.Default.Lookup

// lookupBudget bounds the OSV lookup inside a hook call.
const lookupBudget = 4 * time.Second

// maxManifest caps how many manifest packages are looked up.
const maxManifest = 500

// packages classifies a package manager call: named installs, the registry
// they use, install scripts, and manifest restores.
func (x *actx) packages(cmds []simpleCmd, i int, prog string, rest []string, env map[string]string) {
	switch prog {
	case "npm", "pnpm", "yarn", "bun", "npx", "bunx", "pnpx":
		x.npm(prog, rest, env)
	case "pip", "pip3", "uv", "uvx", "pipx", "poetry", "pdm", "rye":
		x.pip(prog, rest, env)
	case "python", "python3":
		if len(rest) > 1 && rest[0] == "-m" && (rest[1] == "pip" || rest[1] == "pip3") {
			x.pip("pip", rest[2:], env)
		}
	case "cargo":
		if p := positional(rest, nil); len(p) > 1 && (p[0] == "add" || p[0] == "install") {
			for _, s := range p[1:] {
				name, ver, _ := strings.Cut(s, "@")
				x.named(pkgRef{eco: "cargo", name: name, version: strings.TrimPrefix(ver, "=")}, prog+" "+p[0])
			}
			if v, ok := flagValue(rest, "--git", "--registry", "--index"); ok {
				x.registry(v, "cargo")
			}
		}
	case "go":
		if p := positional(rest, nil); len(p) > 1 && (p[0] == "get" || p[0] == "install") {
			for _, s := range p[1:] {
				if strings.HasPrefix(s, ".") || !strings.Contains(s, ".") {
					continue // local packages
				}
				name, ver, _ := strings.Cut(s, "@")
				if ver == "latest" || ver == "upgrade" || ver == "patch" || ver == "none" {
					ver = ""
				}
				name = strings.TrimSuffix(name, "/...")
				x.named(pkgRef{eco: "go", name: name, version: ver}, "go "+p[0])
			}
		}
	case "gem":
		if p := positional(rest, map[string]bool{"-v": true, "--version": true, "-s": true, "--source": true}); len(p) > 1 && p[0] == "install" {
			ver, _ := flagValue(rest, "-v", "--version")
			for _, s := range p[1:] {
				x.named(pkgRef{eco: "gem", name: s, version: ver}, "gem install")
			}
			if v, ok := flagValue(rest, "-s", "--source"); ok {
				x.registry(v, "gem")
			}
		}
	case "brew":
		if p := positional(rest, nil); len(p) > 1 && (p[0] == "install" || p[0] == "reinstall") {
			for _, s := range p[1:] {
				x.named(pkgRef{eco: "brew", name: s}, "brew install")
			}
		}
	}
}

// named records a package installed by name.
func (x *actx) named(p pkgRef, how string) {
	if p.name == "" {
		return
	}
	x.f.pkgs = append(x.f.pkgs, p)
	x.add(event.Action{Kind: "package_install", Target: p.String(), Attrs: map[string]string{"via": how}})
}

// registry records an install source outside package_registries.
func (x *actx) registry(u, eco string) {
	if u == "" || x.approvedRegistry(u) {
		return
	}
	x.add(event.Action{Kind: "package_registry", Target: clip(u, 160), Attrs: map[string]string{"ecosystem": eco}})
}

func (x *actx) approvedRegistry(u string) bool {
	if len(x.rule.PackageRegistries) == 0 {
		return false
	}
	u = strings.ToLower(strings.TrimSuffix(u, "/")) + "/"
	return slices.ContainsFunc(x.rule.PackageRegistries, func(r string) bool {
		return strings.HasPrefix(u, strings.ToLower(strings.TrimSuffix(r, "/"))+"/")
	})
}

// sourceSpec: a package spec that names a URL, git repo or path instead of a registry package.
func sourceSpec(s string) bool {
	for _, pre := range []string{"http://", "https://", "git+", "git:", "git@", "github:", "gitlab:", "bitbucket:", "file:", "link:", "./", "../", "/", "~/"} {
		if strings.HasPrefix(s, pre) {
			return true
		}
	}
	return strings.HasSuffix(s, ".tgz") || strings.HasSuffix(s, ".tar.gz") || strings.HasSuffix(s, ".whl") ||
		strings.Count(s, "/") == 1 && !strings.HasPrefix(s, "@") && !strings.Contains(s, "@") // user/repo (GitHub)
}

// npmSpec splits "name@version" and "@scope/name@version".
func npmSpec(s string) (string, string) {
	at := strings.LastIndexByte(s, '@')
	if at <= 0 {
		return s, ""
	}
	name, ver := s[:at], s[at+1:]
	if strings.HasPrefix(ver, "npm:") { // alias@npm:real@ver
		return npmSpec(strings.TrimPrefix(ver, "npm:"))
	}
	return name, exactVersion(ver)
}

var exactVersionRE = regexp.MustCompile(`^=?v?(\d+\.\d+\.\d+[\w.+-]*)$`)

// exactVersion is a pinned version, "" for ranges and tags.
func exactVersion(v string) string {
	if m := exactVersionRE.FindStringSubmatch(v); m != nil {
		return m[1]
	}
	return ""
}

var npmValued = map[string]bool{"--registry": true, "--prefix": true, "-C": true, "--dir": true, "--cwd": true, "--filter": true,
	"-w": true, "--workspace": true, "--tag": true, "-p": true, "--package": true, "--save-prefix": true, "-c": true, "--call": true}

func (x *actx) npm(prog string, rest []string, env map[string]string) {
	pos := positional(rest, npmValued)
	sub, names := "", []string(nil)
	switch prog {
	case "npx", "bunx", "pnpx":
		sub, names = "exec", firstOnly(pos)
		names = append(names, flagValues(rest, "-p", "--package")...)
	default:
		if len(pos) == 0 {
			if prog == "yarn" {
				sub = "install" // bare yarn installs
			}
			break
		}
		sub, names = pos[0], pos[1:]
		switch sub {
		case "i", "add", "install", "isntall", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal":
			sub = "install"
		case "ci", "clean-install", "install-clean", "isntall-clean":
			sub, names = "ci", nil
		case "exec", "dlx", "x":
			if prog == "npm" && sub == "exec" {
				names = append(firstOnly(names), flagValues(rest, "-p", "--package")...)
			} else {
				names = firstOnly(names)
			}
			sub = "exec"
		case "global":
			if prog == "yarn" && len(names) > 0 && names[0] == "add" {
				sub, names = "install", names[1:]
			}
		case "create":
			if len(names) > 0 {
				n := names[0]
				if !strings.HasPrefix(n, "@") {
					n = "create-" + n
				} else if scope, rest, ok := strings.Cut(n, "/"); ok {
					n = scope + "/create-" + rest
				} else {
					n += "/create"
				}
				names = []string{n}
				sub = "exec"
			}
		default:
			return
		}
	}
	if sub == "" {
		return
	}
	for _, s := range []string{x.getenv(env, "NPM_CONFIG_REGISTRY"), x.getenv(env, "npm_config_registry")} {
		x.registry(s, "npm")
	}
	if v, ok := flagValue(rest, "--registry"); ok {
		x.registry(v, "npm")
	}
	for _, n := range names {
		if sourceSpec(n) {
			x.add(event.Action{Kind: "package_registry", Target: clip(n, 160), Attrs: map[string]string{"ecosystem": "npm"}})
			continue
		}
		name, ver := npmSpec(n)
		x.named(pkgRef{eco: "npm", name: name, version: ver}, prog+" "+sub)
	}
	if sub == "exec" {
		return
	}
	if !hasFlag(rest, "--ignore-scripts") && !truthy(x.getenv(env, "npm_config_ignore_scripts")) && !truthy(x.getenv(env, "NPM_CONFIG_IGNORE_SCRIPTS")) &&
		!(prog == "pnpm" || prog == "bun") { // pnpm ≥10 and bun run only trusted packages' scripts by default
		x.add(event.Action{Kind: "package_scripts", Target: prog + " " + sub, Attrs: map[string]string{"ecosystem": "npm"}})
	}
	if len(names) == 0 {
		x.npmManifest()
	}
}

func firstOnly(s []string) []string {
	if len(s) == 0 {
		return nil
	}
	return s[:1]
}

func truthy(s string) bool { s = strings.ToLower(s); return s == "true" || s == "1" || s == "yes" }

// npmManifest adds package.json's dependencies, with the versions the
// lockfile pins.
func (x *actx) npmManifest() {
	pj := findUp(x.cwd, "package.json")
	if pj == "" {
		return
	}
	var pkg struct {
		Deps    map[string]string `json:"dependencies"`
		DevDeps map[string]string `json:"devDependencies"`
		Opt     map[string]string `json:"optionalDependencies"`
	}
	if json.Unmarshal([]byte(readUserText(x.in, pj)), &pkg) != nil {
		return
	}
	var lock struct {
		Packages map[string]struct {
			Version string `json:"version"`
		} `json:"packages"`
	}
	_ = json.Unmarshal([]byte(readUserText(x.in, path.Join(path.Dir(pj), "package-lock.json"))), &lock)
	n := 0
	for _, deps := range []map[string]string{pkg.Deps, pkg.DevDeps, pkg.Opt} {
		for name, spec := range deps {
			if n >= maxManifest {
				return
			}
			if sourceSpec(spec) || strings.HasPrefix(spec, "workspace:") {
				if !strings.HasPrefix(spec, "workspace:") && !strings.HasPrefix(spec, "file:") && !strings.HasPrefix(spec, "link:") {
					x.add(event.Action{Kind: "package_registry", Target: name + "@" + clip(spec, 120), Attrs: map[string]string{"ecosystem": "npm", "manifest": "package.json"}})
				}
				continue
			}
			ver := lock.Packages["node_modules/"+name].Version
			if ver == "" {
				ver = exactVersion(spec)
			}
			x.f.pkgs = append(x.f.pkgs, pkgRef{eco: "npm", name: name, version: ver, manifest: "package.json"})
			n++
		}
	}
}

var pipValued = map[string]bool{"-r": true, "--requirement": true, "-c": true, "--constraint": true, "-i": true, "--index-url": true,
	"--extra-index-url": true, "-f": true, "--find-links": true, "-e": true, "--editable": true, "-t": true, "--target": true,
	"--python": true, "-p": true, "--with": true, "--from": true, "--index": true, "--default-index": true, "--group": true,
	"--extra": true, "-E": true, "--source": true, "--prefix": true, "--root": true, "--trusted-host": true}

var pipSpecRE = regexp.MustCompile(`^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(?:==\s*([\w.+!-]+))?`)

func (x *actx) pip(prog string, rest []string, env map[string]string) {
	pos := positional(rest, pipValued)
	var names []string
	how := prog
	switch prog {
	case "pip", "pip3":
		if len(pos) == 0 || pos[0] != "install" && pos[0] != "download" {
			return
		}
		names, how = pos[1:], prog+" install"
	case "uv":
		switch {
		case len(pos) > 1 && pos[0] == "pip" && pos[1] == "install":
			names, how = pos[2:], "uv pip install"
		case len(pos) > 0 && pos[0] == "add":
			names, how = pos[1:], "uv add"
		case len(pos) > 2 && pos[0] == "tool" && (pos[1] == "install" || pos[1] == "run"):
			names, how = pos[2:3], "uv tool "+pos[1]
		case len(pos) > 0 && pos[0] == "sync":
			how = "uv sync"
		default:
			return
		}
	case "uvx":
		names = firstOnly(pos)
		if f, ok := flagValue(rest, "--from"); ok {
			names = []string{f}
		}
	case "pipx":
		if len(pos) < 2 || pos[0] != "install" && pos[0] != "run" && pos[0] != "inject" {
			return
		}
		names, how = pos[1:2], "pipx "+pos[0]
		if pos[0] == "inject" {
			names = pos[2:]
		}
	case "poetry", "pdm", "rye":
		if len(pos) == 0 || pos[0] != "add" {
			return
		}
		names, how = pos[1:], prog+" add"
	}
	names = append(names, flagValues(rest, "--with")...)
	for _, k := range []string{"PIP_INDEX_URL", "UV_INDEX_URL", "UV_DEFAULT_INDEX"} {
		x.registry(x.getenv(env, k), "pypi")
	}
	for _, v := range flagValues(rest, "-i", "--index-url", "--default-index", "--index") {
		x.registry(v, "pypi")
	}
	extras := append(flagValues(rest, "--extra-index-url", "-f", "--find-links"), x.getenv(env, "PIP_EXTRA_INDEX_URL"), x.getenv(env, "UV_EXTRA_INDEX_URL"))
	for _, v := range extras {
		if v != "" && !x.approvedRegistry(v) {
			// an extra index lets a public package shadow an internal one
			x.add(event.Action{Kind: "package_registry", Target: clip(v, 160), Attrs: map[string]string{"ecosystem": "pypi", "extra_index": "true"}})
		}
	}
	for _, n := range names {
		if sourceSpec(n) || strings.Contains(n, "://") || strings.Contains(n, " @ ") {
			x.add(event.Action{Kind: "package_registry", Target: clip(n, 160), Attrs: map[string]string{"ecosystem": "pypi"}})
			continue
		}
		if m := pipSpecRE.FindStringSubmatch(n); m != nil {
			x.named(pkgRef{eco: "pypi", name: normPyPI(m[1]), version: m[2]}, how)
		}
	}
	for _, r := range flagValues(rest, "-r", "--requirement") {
		x.requirements(resolveIn(r, x.cwd, x.home), 0)
	}
}

// normPyPI normalises a PyPI name (PEP 503).
func normPyPI(n string) string {
	return strings.ToLower(pypiSepRE.ReplaceAllString(n, "-"))
}

var pypiSepRE = regexp.MustCompile(`[-_.]+`)

// requirements adds a requirements file's packages (following -r once).
func (x *actx) requirements(p string, depth int) {
	sc := bufio.NewScanner(strings.NewReader(readUserText(x.in, p)))
	n := 0
	for sc.Scan() && n < maxManifest {
		l := strings.TrimSpace(sc.Text())
		if i := strings.Index(l, " #"); i >= 0 {
			l = strings.TrimSpace(l[:i])
		}
		switch {
		case l == "" || l[0] == '#':
		case strings.HasPrefix(l, "-r ") || strings.HasPrefix(l, "--requirement "):
			if depth == 0 {
				_, f, _ := strings.Cut(l, " ")
				x.requirements(resolve(strings.TrimSpace(f), path.Dir(p)), 1)
			}
		case strings.HasPrefix(l, "--extra-index-url") || strings.HasPrefix(l, "-i ") || strings.HasPrefix(l, "--index-url"):
			f := strings.Fields(strings.ReplaceAll(l, "=", " "))
			if len(f) > 1 && !x.approvedRegistry(f[1]) {
				x.add(event.Action{Kind: "package_registry", Target: clip(f[1], 160), Attrs: map[string]string{"ecosystem": "pypi", "manifest": path.Base(p)}})
			}
		case strings.HasPrefix(l, "-"):
		case strings.Contains(l, "://") || strings.Contains(l, " @ "):
			x.add(event.Action{Kind: "package_registry", Target: clip(l, 160), Attrs: map[string]string{"ecosystem": "pypi", "manifest": path.Base(p)}})
		default:
			if m := pipSpecRE.FindStringSubmatch(l); m != nil {
				x.f.pkgs = append(x.f.pkgs, pkgRef{eco: "pypi", name: normPyPI(m[1]), version: m[2], manifest: path.Base(p)})
				n++
			}
		}
	}
}

// pkgMatch matches a package against ecosystem:name[@version] patterns.
func pkgMatch(list []string, p pkgRef) string {
	for _, e := range list {
		eco, rest, _ := strings.Cut(e, ":")
		if eco != p.eco {
			continue
		}
		name, ver := rest, ""
		if at := strings.LastIndexByte(rest, '@'); at > 0 {
			name, ver = rest[:at], rest[at+1:]
		}
		if p.eco == "pypi" {
			name = normPyPI(name)
		}
		if wild(name, p.name) && (ver == "" || wild(ver, p.version)) {
			return e
		}
	}
	return ""
}

// lookupPackages adds package_unlisted (package_allow), and, when a policy
// names them, package_malicious / package_vulnerable from OSV.
func (x *actx) lookupPackages() {
	if len(x.f.pkgs) == 0 {
		return
	}
	if len(x.rule.PackageAllow) > 0 {
		for _, p := range x.f.pkgs {
			if pkgMatch(x.rule.PackageAllow, p) == "" {
				x.add(event.Action{Kind: "package_unlisted", Target: p.String(), In: p.manifest})
			}
		}
	}
	if !listsName(x.rule, "package_malicious", "package_vulnerable") || PackageLookup == nil {
		return
	}
	var ask []osv.Pkg
	for _, p := range x.f.pkgs {
		if osv.Supported(p.eco) {
			ask = append(ask, osv.Pkg{Ecosystem: p.eco, Name: p.name, Version: p.version})
		}
	}
	if len(ask) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), lookupBudget)
	defer cancel()
	found, err := PackageLookup(ctx, ask)
	manifest := map[string]string{}
	for _, p := range x.f.pkgs {
		manifest[p.String()] = p.manifest
	}
	for _, f := range found {
		ref := pkgRef{eco: f.Ecosystem, name: f.Name, version: f.Version}
		if len(f.Malicious) > 0 {
			x.add(event.Action{Kind: "package_malicious", Target: ref.String(), In: manifest[ref.String()],
				Attrs: map[string]string{"osv": strings.Join(f.Malicious[:min(5, len(f.Malicious))], ",")}})
		}
		if len(f.Vulnerable) > 0 {
			x.add(event.Action{Kind: "package_vulnerable", Target: ref.String(), In: manifest[ref.String()],
				Attrs: map[string]string{"osv": strings.Join(f.Vulnerable[:min(5, len(f.Vulnerable))], ","), "count": strconv.Itoa(len(f.Vulnerable))}})
		}
	}
	if err != nil {
		// fail open: the lookup error is recorded on the installs, nothing is blocked for it
		for k := range x.f.actions {
			if a := &x.f.actions[k]; a.Kind == "package_install" {
				a.Attrs = withAttr(a.Attrs, "osv_error", clip(err.Error(), 120))
			}
		}
	}
}
