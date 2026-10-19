package spend

import (
	"reflect"
	"testing"
	"time"
)

func TestDailyUsage(t *testing.T) {
	got := DailyUsage([]UsageDay{
		// OpenAI: the organisation's cost for the day, people by token share
		{Vendor: OpenAI, Day: daysAgo(1), Identity: "", CostCents: 1000, Source: "api"},
		{Vendor: OpenAI, Day: daysAgo(1).Add(3 * time.Hour), Identity: "a@acme.io", CostCents: 600, Tokens: 60, Estimated: true},
		{Vendor: OpenAI, Day: daysAgo(1), Identity: "b@acme.io", CostCents: 300, Tokens: 30, Estimated: true},
		// Cursor: per person only; an idle row isn't a person with use
		{Vendor: Cursor, Day: daysAgo(1), Identity: "a@acme.io", CostCents: 120, Requests: 4},
		{Vendor: Cursor, Day: daysAgo(1), Identity: "c@acme.io"},
		// Anthropic: an organisation total only
		{Vendor: Anthropic, Day: daysAgo(0), Identity: "", CostCents: 50, Requests: 7, Tokens: 900},
	})
	want := []UsagePoint{
		{Day: daysAgo(1), Vendor: Cursor, CostCents: 120, Requests: 4, People: 1},
		{Day: daysAgo(1), Vendor: OpenAI, CostCents: 1000, Tokens: 90, People: 2, Estimated: true},
		{Day: daysAgo(0), Vendor: Anthropic, CostCents: 50, Requests: 7, Tokens: 900},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("DailyUsage:\n got %+v\nwant %+v", got, want)
	}
}

func TestDailyActivity(t *testing.T) {
	got := DailyActivity([]ActivityRow{
		{Day: daysAgo(2), Agent: "claude-code", EndpointID: "m1", Events: 10},
		{Day: daysAgo(2), Agent: "claude-cowork", EndpointID: "m1", Events: 2},
		{Day: daysAgo(2), Agent: "claude-code", EndpointID: "m2", Events: 5},
		{Day: daysAgo(2), Agent: "mcp:github", EndpointID: "m2", Events: 50}, // not billed
		{Day: daysAgo(1), Agent: "codex", EndpointID: "m3", Events: 1},
	})
	want := []ActivityPoint{
		{Day: daysAgo(2), Vendor: Anthropic, Events: 17, Machines: 2, Agents: []string{"claude-code", "claude-cowork"}},
		{Day: daysAgo(1), Vendor: OpenAI, Events: 1, Machines: 1, Agents: []string{"codex"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("DailyActivity:\n got %+v\nwant %+v", got, want)
	}
}
