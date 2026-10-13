// Package redact removes secrets from event text before it leaves the
// machine (PRD FR-12). Detection uses gitleaks' maintained default rule set;
// each detected secret is replaced with "[REDACTED:<rule>]".
package redact

import (
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
	return s
}
