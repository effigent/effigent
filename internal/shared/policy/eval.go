package policy

import (
	"fmt"
	"sort"
	"time"

	"github.com/effigent/effigent/internal/shared/action"
)

func rank(d Decision) int {
	switch d {
	case Deny:
		return 2
	case RequireApproval:
		return 1
	}
	return 0
}

type candidate struct {
	p *Policy
	r *Rule
}

// Evaluate decides one action. Precedence (FR-15), first difference wins:
//  1. lower policy priority, 2. lower rule priority,
//  3. stricter decision (deny > require_approval > allow), 4. smaller rule id.
//
// With no matching rule, the strictest default among the policies in scope
// applies. With no policy in scope, the action is allowed and says so.
func Evaluate(policies []Policy, sub Subject, a action.Action, now time.Time) Result {
	var cands []candidate
	var inScope []*Policy
	for i := range policies {
		p := &policies[i]
		if !p.Enabled || !p.Scope.matches(sub) {
			continue
		}
		inScope = append(inScope, p)
		for j := range p.Rules {
			r := &p.Rules[j]
			if r.Disabled || (r.ValidUntil != nil && !now.Before(*r.ValidUntil)) {
				continue
			}
			if r.Who.matches(sub) && r.What.matches(a) {
				cands = append(cands, candidate{p, r})
			}
		}
	}
	if len(cands) > 0 {
		sort.SliceStable(cands, func(i, j int) bool {
			a, b := cands[i], cands[j]
			if a.p.Priority != b.p.Priority {
				return a.p.Priority < b.p.Priority
			}
			if a.r.Priority != b.r.Priority {
				return a.r.Priority < b.r.Priority
			}
			if rank(a.r.Decision) != rank(b.r.Decision) {
				return rank(a.r.Decision) > rank(b.r.Decision)
			}
			return a.r.ID < b.r.ID
		})
		w := cands[0]
		reason := w.r.Description
		if reason == "" {
			reason = fmt.Sprintf("rule %s in %s", w.r.ID, w.p.Name)
		}
		return Result{Decision: w.r.Decision, PolicyID: w.p.ID, PolicyVersion: w.p.Version, RuleID: w.r.ID,
			Reason: reason, Approval: w.r.Approval}
	}
	if len(inScope) == 0 {
		return Result{Decision: Allow, Reason: "no policy applies"}
	}
	best := inScope[0]
	for _, p := range inScope[1:] {
		if rank(p.Default) > rank(best.Default) {
			best = p
		}
	}
	d := best.Default
	if d == "" {
		d = Allow
	}
	return Result{Decision: d, PolicyID: best.ID, PolicyVersion: best.Version,
		Reason: fmt.Sprintf("default of %s", best.Name)}
}

// Validate reports problems that would make a policy ambiguous or unusable.
func Validate(p Policy) []string {
	var errs []string
	if p.Name == "" {
		errs = append(errs, "name is required")
	}
	switch p.Default {
	case "", Allow, Deny, RequireApproval:
	default:
		errs = append(errs, fmt.Sprintf("unknown default %q", p.Default))
	}
	seen := map[string]bool{}
	for i, r := range p.Rules {
		where := fmt.Sprintf("rule %d", i+1)
		if r.ID == "" {
			errs = append(errs, where+": id is required")
		} else if seen[r.ID] {
			errs = append(errs, where+": duplicate id "+r.ID)
		}
		seen[r.ID] = true
		switch r.Decision {
		case Allow, Deny, RequireApproval:
		default:
			errs = append(errs, fmt.Sprintf("%s: unknown decision %q", where, r.Decision))
		}
		if r.Decision == RequireApproval && r.Approval == nil {
			errs = append(errs, where+": require_approval needs an approval block (who can approve)")
		}
		for _, c := range r.What.Classes {
			known := false
			for _, k := range action.Classes {
				known = known || k == c
			}
			if !known {
				errs = append(errs, fmt.Sprintf("%s: unknown action class %q", where, c))
			}
		}
	}
	return errs
}
