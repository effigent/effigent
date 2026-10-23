// Package redact removes secrets from event text before it leaves the
// machine (PRD FR-12). Detection uses gitleaks' maintained default rule set,
// then rules gitleaks misses on command lines (NAME_TOKEN=…, --password …,
// user:pass@ in URLs, bearer tokens, private key blocks, SQL PASSWORD '…'),
// then the workspace's own masks and optional PII masks from the policy
// (Configure).
// Each value is replaced with "[REDACTED:<rule>]".
package redact

import (
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/zricethezav/gitleaks/v8/detect"
)

var (
	once sync.Once
	mu   sync.Mutex
	det  *detect.Detector
)

func detector() *detect.Detector {
	once.Do(func() {
		d, err := detect.NewDetectorDefaultConfig()
		if err == nil {
			det = d
		}
	})
	return det
}

// String returns s with every detected secret replaced.
func String(s string) string {
	if s == "" {
		return s
	}
	d := detector()
	if d == nil {
		return s
	}
	mu.Lock()
	findings := d.DetectString(s)
	mu.Unlock()
	for _, f := range findings {
		if f.Secret != "" {
			s = strings.ReplaceAll(s, f.Secret, "[REDACTED:"+f.RuleID+"]")
		}
	}
	return extra(s)
}

var (
	privateKeyRE = regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)`)
	// NAME=value / name: value where the name says it's a secret, env style
	// included (GITHUB_TOKEN=, DB_PASSWORD=, AWS_SECRET_ACCESS_KEY=).
	assignRE = regexp.MustCompile(`(?i)\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"',;&|)]+)`)
	flagRE   = regexp.MustCompile(`(?i)(\s--?(?:password|passwd|pass|token|secret|api-?key|access-?key|auth-token|client-secret)(?:=|\s+))("[^"]*"|'[^']*'|[^\s"']+)`)
	urlRE    = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://[^\s:@/"']+:)([^\s@/"']+)(@)`)
	bearerRE = regexp.MustCompile(`(?i)(\b(?:bearer|basic|token)\s+)([A-Za-z0-9._~+/-]{12,}=*)`)
	// mysql -pSECRET
	mysqlPassRE = regexp.MustCompile(`(\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^|;&\n]*\s-p)([^\s"']{2,})`)
	// SQL: CREATE/ALTER USER … PASSWORD '…', IDENTIFIED BY '…' (heredocs and
	// here-strings fed to a database client are part of the command text)
	sqlPassRE = regexp.MustCompile(`(?i)(\b(?:password|identified\s+by)\s+)('[^']*'|"[^"]*")`)
)

func extra(s string) string {
	s = privateKeyRE.ReplaceAllString(s, "[REDACTED:private-key]")
	s = urlRE.ReplaceAllString(s, "${1}[REDACTED:url-password]${3}")
	keep := func(re *regexp.Regexp, rule string) {
		s = re.ReplaceAllStringFunc(s, func(m string) string {
			sub := re.FindStringSubmatch(m)
			v := strings.Trim(sub[2], `"'`)
			if v == "" || len(v) < 3 || strings.HasPrefix(v, "[REDACTED") || strings.ContainsAny(v[:1], "$</~.") {
				return m // a variable, a placeholder, a path, already redacted
			}
			return sub[1] + "[REDACTED:" + rule + "]"
		})
	}
	keep(assignRE, "assignment")
	keep(flagRE, "flag")
	keep(bearerRE, "bearer")
	keep(mysqlPassRE, "flag")
	keep(sqlPassRE, "sql-password")
	return Masks(s)
}

// Masks applies only the workspace's own masks and the PII masks (Configure),
// not the secret rules: for paths (working directories, binaries, transcript
// files), where a customer or person name is what has to go, and which come
// with every kernel event.
func Masks(s string) string {
	if s == "" {
		return s
	}
	cmu.RLock()
	rules := custom
	cmu.RUnlock()
	for _, r := range rules {
		s = r.re.ReplaceAllString(s, "[REDACTED:"+r.name+"]")
	}
	return s
}

// Rule is a workspace mask: a name and a regular expression.
type Rule struct {
	Name    string `yaml:"name" json:"name"`
	Pattern string `yaml:"pattern" json:"pattern"`
}

type compiled struct {
	name string
	re   *regexp.Regexp
}

var (
	cmu    sync.RWMutex
	custom []compiled
)

// MaxRules and MaxPattern bound a policy's masks.
const (
	MaxRules   = 50
	MaxPattern = 300
)

var nameRE = regexp.MustCompile(`^[a-z0-9_-]{2,32}$`)

// PII masks, off unless the policy turns them on: they also hide emails and
// phone numbers people need in the console.
var pii = []Rule{
	{"email", `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`},
	{"phone", `\+\d{1,3}[-. ]?\(?\d{1,4}\)?[-. ]?\d{2,4}[-. ]?\d{3,7}\b`},
	{"card", `\b(?:\d[ -]?){13,16}\b`},
	{"iban", `\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b`},
}

// Compile checks masks; Configure applies them.
func Compile(rules []Rule, withPII bool) ([]compiled, error) {
	if len(rules) > MaxRules {
		return nil, fmt.Errorf("redact: at most %d patterns", MaxRules)
	}
	var out []compiled
	for _, r := range rules {
		if !nameRE.MatchString(r.Name) {
			return nil, fmt.Errorf("redact pattern name %q: 2-32 of a-z, 0-9, _ and -", r.Name)
		}
		if r.Pattern == "" || len(r.Pattern) > MaxPattern {
			return nil, fmt.Errorf("redact pattern %s: 1-%d characters", r.Name, MaxPattern)
		}
		re, err := regexp.Compile(r.Pattern)
		if err != nil {
			return nil, fmt.Errorf("redact pattern %s: %w", r.Name, err)
		}
		if re.MatchString("") {
			return nil, fmt.Errorf("redact pattern %s matches empty text", r.Name)
		}
		out = append(out, compiled{r.Name, re})
	}
	if withPII {
		for _, r := range pii {
			out = append(out, compiled{r.Name, regexp.MustCompile(r.Pattern)})
		}
	}
	return out, nil
}

// Configure sets the workspace masks (and PII masks) applied after the
// built-in rules. An invalid set leaves the previous one in place.
func Configure(rules []Rule, withPII bool) error {
	c, err := Compile(rules, withPII)
	if err != nil {
		return err
	}
	cmu.Lock()
	custom = c
	cmu.Unlock()
	return nil
}
