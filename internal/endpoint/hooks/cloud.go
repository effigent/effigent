package hooks

import (
	"bufio"
	"encoding/json"
	"os"
	"path"
	"regexp"
	"strings"

	"github.com/effigent/effigent/internal/endpoint/event"
)

var cloudCLIs = map[string]bool{"aws": true, "gcloud": true, "az": true, "kubectl": true, "oc": true, "helm": true,
	"terraform": true, "tofu": true, "terragrunt": true, "pulumi": true, "eksctl": true}

// cloudValued are global flags of the cloud CLIs that take a value.
var cloudValued = map[string]bool{"--profile": true, "--region": true, "--output": true, "--endpoint-url": true, "--query": true,
	"--project": true, "--subscription": true, "--context": true, "-n": true, "--namespace": true, "--kubeconfig": true,
	"-o": true, "--cluster": true, "--kube-context": true, "-s": true, "--stack": true, "--configuration": true,
	"-g": true, "--resource-group": true, "--format": true, "--cli-read-timeout": true, "--cli-connect-timeout": true,
	"-l": true, "--selector": true, "-f": true, "--filename": true, "--zone": true, "--location": true, "--name": true,
	"--var": true, "--var-file": true, "-target": true, "--target": true, "-p": true, "--parallelism": true}

// cloud classifies a cloud or cluster CLI call: read (access), change, or
// destroy, with the identity it acts as.
func (x *actx) cloud(prog string, args []string, env map[string]string) {
	pos := positional(args, cloudValued)
	attrs := map[string]string{"cli": prog}
	kind, op := "access", prog+" "+strings.Join(pos[:min(3, len(pos))], " ")
	switch prog {
	case "aws":
		x.awsIdentity(args, env, attrs)
		if len(pos) < 2 || awsLocal[pos[0]] {
			return
		}
		service, verb := pos[0], pos[1]
		switch {
		case service == "s3":
			switch {
			case verb == "rb" || verb == "rm" || verb == "sync" && hasFlag(args, "--delete") || verb == "mv":
				kind = "cloud_destroy"
			case verb == "cp" || verb == "sync" || verb == "mb" || verb == "website":
				kind = "cloud_change"
				if verb == "cp" && (len(pos) < 4 || !strings.HasPrefix(pos[len(pos)-1], "s3://")) {
					kind = "access" // a download
				}
			}
		case awsDestroyRE.MatchString(verb):
			kind = "cloud_destroy"
		case !awsReadRE.MatchString(verb):
			kind = "cloud_change"
		}
		op = "aws " + service + " " + verb
	case "gcloud":
		x.gcloudIdentity(args, env, attrs)
		if len(pos) == 0 || gcloudLocal[pos[0]] {
			return
		}
		kind = verbKind(pos, map[string]bool{"delete": true, "remove": true, "destroy": true},
			map[string]bool{"list": true, "describe": true, "get": true, "show": true, "read": true, "get-iam-policy": true,
				"get-credentials": true, "print-access-token": true, "tail": true, "logs": true, "browse": true})
		op = "gcloud " + strings.Join(pos[:min(4, len(pos))], " ")
	case "az":
		x.azureIdentity(args, env, attrs)
		if len(pos) == 0 || azLocal[pos[0]] {
			return
		}
		kind = verbKind(pos, map[string]bool{"delete": true, "purge": true, "remove": true},
			map[string]bool{"list": true, "show": true, "get": true, "list-keys": true, "query": true, "wait": true, "exists": true, "download": true, "tail": true})
		op = "az " + strings.Join(pos[:min(4, len(pos))], " ")
	case "kubectl", "oc":
		x.kubeIdentity(args, env, attrs, "--context")
		if len(pos) == 0 || kubeLocal[pos[0]] {
			return
		}
		switch v := pos[0]; {
		case v == "delete" || v == "drain":
			kind = "cloud_destroy"
		case !kubeRead[v]:
			kind = "cloud_change"
		}
		if pos[0] == "get" && len(pos) > 1 && strings.HasPrefix(pos[1], "secret") && hasFlag(args, "-o", "--output") {
			x.add(event.Action{Kind: "credential_read", Target: "kubectl get secrets", Attrs: attrs})
		}
		op = prog + " " + strings.Join(pos[:min(3, len(pos))], " ")
	case "helm":
		x.kubeIdentity(args, env, attrs, "--kube-context")
		if len(pos) == 0 {
			return
		}
		switch pos[0] {
		case "uninstall", "delete", "del", "un":
			kind = "cloud_destroy"
		case "install", "upgrade", "rollback", "i":
			kind = "cloud_change"
		default:
			return
		}
	case "eksctl":
		x.awsIdentity(args, env, attrs)
		if len(pos) == 0 {
			return
		}
		kind = verbKind(pos[:1], map[string]bool{"delete": true, "drain": true}, map[string]bool{"get": true, "info": true, "version": true, "utils": true})
	case "terraform", "tofu", "terragrunt":
		x.terraformIdentity(args, env, attrs)
		if len(pos) == 0 {
			return
		}
		switch v := pos[0]; {
		case v == "destroy" || v == "apply" && hasFlag(args, "-destroy", "--destroy") || v == "state" && len(pos) > 1 && pos[1] == "rm":
			kind = "cloud_destroy"
		case v == "apply" || v == "import" || v == "taint" || v == "untaint" || v == "state" || v == "run-all" || v == "force-unlock":
			kind = "cloud_change"
		case v == "plan" || v == "refresh":
			kind = "access"
		default:
			return // init, validate, fmt, output, show, version…
		}
	case "pulumi":
		if s, ok := flagValue(args, "-s", "--stack"); ok {
			attrs["pulumi_stack"] = s
		}
		x.awsIdentity(args, env, attrs)
		if len(pos) == 0 {
			return
		}
		switch v := pos[0]; {
		case v == "destroy" || v == "stack" && len(pos) > 1 && pos[1] == "rm":
			kind = "cloud_destroy"
		case v == "up" || v == "update" || v == "refresh" || v == "import" || v == "state" || v == "cancel":
			kind = "cloud_change"
		case v == "preview":
			kind = "access"
		default:
			return
		}
	}
	if !identified(attrs) {
		attrs["target"] = "unknown"
	}
	x.add(event.Action{Kind: kind, Target: strings.TrimSpace(op), Attrs: attrs})
}

// identified: the action's target identity is known.
func identified(attrs map[string]string) bool {
	for _, k := range []string{"aws_profile", "aws_account", "kube_context", "gcloud_project", "azure_subscription", "terraform_workspace", "pulumi_stack"} {
		if attrs[k] != "" {
			return true
		}
	}
	return false
}

// verbKind finds the verb among a gcloud / az command's words.
func verbKind(pos []string, destroy, read map[string]bool) string {
	for _, w := range pos {
		if destroy[w] {
			return "cloud_destroy"
		}
	}
	for _, w := range pos {
		if read[w] || strings.HasPrefix(w, "list-") || strings.HasPrefix(w, "get-") || strings.HasPrefix(w, "describe") {
			return "access"
		}
	}
	return "cloud_change"
}

var (
	awsDestroyRE = regexp.MustCompile(`^(terminate|delete|remove|deregister|purge|disassociate|detach|revoke|cancel|stop|disable|reset|release|reject|batch-delete|deactivate)-`)
	awsReadRE    = regexp.MustCompile(`^(describe|list|get|head|scan|query|search|lookup|filter|select|batch-get|download|test|validate|simulate|estimate|preview|poll|wait|tail|check|ls|presign|help)\b`)
	awsLocal     = map[string]bool{"configure": true, "sso": true, "help": true, "history": true}
	gcloudLocal  = map[string]bool{"config": true, "auth": true, "components": true, "info": true, "help": true, "version": true, "init": true, "topic": true, "feedback": true, "survey": true}
	azLocal      = map[string]bool{"login": true, "logout": true, "account": true, "config": true, "extension": true, "version": true, "find": true, "upgrade": true, "init": true, "cloud": true, "interactive": true, "feedback": true}
	kubeLocal    = map[string]bool{"config": true, "version": true, "completion": true, "plugin": true, "kustomize": true, "options": true, "help": true, "explain": true, "api-resources": true, "api-versions": true}
	kubeRead     = map[string]bool{"get": true, "describe": true, "logs": true, "top": true, "cluster-info": true, "auth": true, "diff": true, "wait": true, "events": true, "port-forward": true, "proxy": true}
)

// ---- identities ----

func (x *actx) awsIdentity(args []string, env map[string]string, attrs map[string]string) {
	profile, _ := flagValue(args, "--profile")
	if profile == "" {
		profile = x.getenv(env, "AWS_PROFILE")
	}
	if profile == "" {
		profile = x.getenv(env, "AWS_DEFAULT_PROFILE")
	}
	if region, ok := flagValue(args, "--region"); ok {
		attrs["aws_region"] = region
	} else if r := x.getenv(env, "AWS_REGION"); r != "" {
		attrs["aws_region"] = r
	}
	if x.getenv(env, "AWS_ACCESS_KEY_ID") != "" && profile == "" {
		attrs["aws_auth"] = "access keys in the environment"
		return
	}
	if profile == "" {
		profile = "default"
	}
	attrs["aws_profile"] = profile
	cfg := x.getenv(env, "AWS_CONFIG_FILE")
	if cfg == "" {
		cfg = x.home + "/.aws/config"
	}
	if acct := awsAccount(readUserText(x.in, resolveIn(cfg, x.cwd, x.home)), profile); acct != "" {
		attrs["aws_account"] = acct
	}
}

var arnAccountRE = regexp.MustCompile(`^arn:aws[\w-]*:iam::(\d{12}):`)

// awsAccount finds a profile's account in ~/.aws/config: sso_account_id,
// or the account of role_arn (following source_profile once).
func awsAccount(cfg, profile string) string {
	sections := iniSections(cfg)
	for range 3 {
		name := "profile " + profile
		if profile == "default" {
			name = "default"
		}
		s, ok := sections[name]
		if !ok {
			return ""
		}
		if a := s["sso_account_id"]; a != "" {
			return a
		}
		if m := arnAccountRE.FindStringSubmatch(s["role_arn"]); m != nil {
			return m[1]
		}
		if s["source_profile"] == "" {
			return ""
		}
		profile = s["source_profile"]
	}
	return ""
}

// iniSections reads an INI file into section -> key -> value.
func iniSections(s string) map[string]map[string]string {
	out := map[string]map[string]string{}
	cur := ""
	sc := bufio.NewScanner(strings.NewReader(s))
	for sc.Scan() {
		l := strings.TrimSpace(sc.Text())
		if l == "" || l[0] == '#' || l[0] == ';' {
			continue
		}
		if strings.HasPrefix(l, "[") && strings.HasSuffix(l, "]") {
			cur = strings.TrimSpace(l[1 : len(l)-1])
			if out[cur] == nil {
				out[cur] = map[string]string{}
			}
			continue
		}
		if k, v, ok := strings.Cut(l, "="); ok && cur != "" {
			out[cur][strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return out
}

var currentContextRE = regexp.MustCompile(`(?m)^current-context:\s*["']?([^"'\n]+?)["']?\s*$`)

func (x *actx) kubeIdentity(args []string, env map[string]string, attrs map[string]string, flag string) {
	if c, ok := flagValue(args, flag); ok {
		attrs["kube_context"] = c
	} else {
		var cfgs []string
		if cfg, _ := flagValue(args, "--kubeconfig"); cfg != "" {
			cfgs = []string{cfg}
		} else {
			// KUBECONFIG is a list merged in order: the first file that sets
			// current-context wins, as in kubectl.
			for _, c := range strings.Split(x.getenv(env, "KUBECONFIG"), string(os.PathListSeparator)) {
				if c != "" && len(cfgs) < 16 {
					cfgs = append(cfgs, c)
				}
			}
		}
		if len(cfgs) == 0 {
			cfgs = []string{x.home + "/.kube/config"}
		}
		for _, cfg := range cfgs {
			if m := currentContextRE.FindStringSubmatch(readUserText(x.in, resolveIn(cfg, x.cwd, x.home))); m != nil {
				attrs["kube_context"] = m[1]
				break
			}
		}
	}
	if ns, ok := flagValue(args, "-n", "--namespace"); ok {
		attrs["kube_namespace"] = ns
	}
}

func (x *actx) gcloudIdentity(args []string, env map[string]string, attrs map[string]string) {
	if p, ok := flagValue(args, "--project"); ok {
		attrs["gcloud_project"] = p
		return
	}
	if p := x.getenv(env, "CLOUDSDK_CORE_PROJECT"); p != "" {
		attrs["gcloud_project"] = p
		return
	}
	dir := x.getenv(env, "CLOUDSDK_CONFIG")
	if dir == "" {
		dir = x.home + "/.config/gcloud"
	}
	dir = resolveIn(dir, x.cwd, x.home)
	name, _ := flagValue(args, "--configuration")
	if name == "" {
		name = x.getenv(env, "CLOUDSDK_ACTIVE_CONFIG_NAME")
	}
	if name == "" {
		name = strings.TrimSpace(readUserText(x.in, path.Join(dir, "active_config")))
	}
	if name == "" {
		name = "default"
	}
	if p := iniSections(readUserText(x.in, path.Join(dir, "configurations", "config_"+name)))["core"]["project"]; p != "" {
		attrs["gcloud_project"] = p
	}
}

func (x *actx) azureIdentity(args []string, env map[string]string, attrs map[string]string) {
	if s, ok := flagValue(args, "--subscription"); ok {
		attrs["azure_subscription"] = s
		return
	}
	dir := x.getenv(env, "AZURE_CONFIG_DIR")
	if dir == "" {
		dir = x.home + "/.azure"
	}
	b := strings.TrimPrefix(readUserText(x.in, path.Join(resolveIn(dir, x.cwd, x.home), "azureProfile.json")), "\ufeff")
	var prof struct {
		Subscriptions []struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			IsDefault bool   `json:"isDefault"`
		} `json:"subscriptions"`
	}
	if json.Unmarshal([]byte(b), &prof) == nil {
		for _, s := range prof.Subscriptions {
			if s.IsDefault {
				attrs["azure_subscription"], attrs["azure_subscription_name"] = s.ID, s.Name
			}
		}
	}
}

func (x *actx) terraformIdentity(args []string, env map[string]string, attrs map[string]string) {
	dir := x.cwd
	for _, a := range args {
		if d, ok := strings.CutPrefix(a, "-chdir="); ok {
			dir = resolveIn(d, x.cwd, x.home)
		}
	}
	ws := x.getenv(env, "TF_WORKSPACE")
	if ws == "" {
		ws = strings.TrimSpace(readUserText(x.in, path.Join(dir, ".terraform", "environment")))
	}
	if ws == "" {
		ws = "default"
	}
	attrs["terraform_workspace"] = ws
	if p := x.getenv(env, "AWS_PROFILE"); p != "" {
		attrs["aws_profile"] = p
	}
	if s := x.getenv(env, "ARM_SUBSCRIPTION_ID"); s != "" {
		attrs["azure_subscription"] = s
	}
	if p := x.getenv(env, "GOOGLE_PROJECT"); p != "" {
		attrs["gcloud_project"] = p
	}
}
