package spend

import (
	"strings"
	"testing"
)

func TestCopilotSeatsCSV(t *testing.T) {
	in := bom + "Login,Last Activity At,Last Activity Editor,Created At,Plan Type\n" +
		"Dana-K,2026-10-01T10:00:00Z,vscode,2026-01-02T00:00:00Z,business\n" +
		"ghost,,,2025-06-01T00:00:00Z,enterprise\n" +
		",2026-10-01T10:00:00Z,vscode,,business\n" +
		"dana-k,2026-10-02T10:00:00Z,vscode,,business\n"
	r, err := ParseCSV(Copilot, CSVSeats, strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Seats) != 2 || r.Rows != 4 || r.Skipped != 2 {
		t.Fatalf("%+v", r)
	}
	s := r.Seats[0]
	if s.Identity != "dana-k" || s.Plan != "business" || s.LastActivity == nil || s.AssignedAt == nil || s.Source != "csv" {
		t.Fatalf("seat %+v", s)
	}
	if r.Seats[1].LastActivity != nil {
		t.Fatal("empty activity must stay unknown")
	}
}

func TestCursorCSV(t *testing.T) {
	members := "Name,Email,Role,Seat Price\nDana Katz,dana@acme.io,Member,$40.00\nOmer,omer@acme.io,Owner,\n"
	r, err := ParseCSV(Cursor, CSVSeats, strings.NewReader(members))
	if err != nil || len(r.Seats) != 2 || r.Seats[0].PriceCents != 4000 || r.Seats[0].Name != "Dana Katz" || r.Seats[1].PriceCents != 0 {
		t.Fatalf("members %+v %v", r, err)
	}
	usage := "Date,User,Kind,Model,Total Tokens,Cost\n" +
		"2026-10-17T09:00:00.000Z,dana@acme.io,Usage-based,claude-opus,1200,$1.20\n" +
		"2026-10-17T11:00:00.000Z,dana@acme.io,Included,gpt-5,800,Included\n" +
		"2026-10-18T11:00:00.000Z,dana@acme.io,Usage-based,gpt-5,10,0.05\n" +
		"not a date,dana@acme.io,x,y,1,1\n"
	r, err = ParseCSV(Cursor, CSVUsage, strings.NewReader(usage))
	if err != nil || len(r.Usage) != 2 || r.Skipped != 1 {
		t.Fatalf("usage %+v %v", r, err)
	}
	if d := r.Usage[0]; d.CostCents != 120 || d.Requests != 2 || d.Tokens != 2000 || d.Identity != "dana@acme.io" {
		t.Fatalf("day 1 %+v", d)
	}
}

func TestCSVErrors(t *testing.T) {
	for _, c := range []struct{ vendor, kind, in string }{
		{Cursor, CSVSeats, ""},
		{Cursor, CSVSeats, "Name,Role\nx,y\n"},
		{Cursor, CSVUsage, "Email,Cost\nx@y.z,1\n"},
		{"nope", CSVSeats, "Email\nx@y.z\n"},
		{Cursor, "bogus", "Email\nx@y.z\n"},
		{Cursor, CSVSeats, "Email\n\n"},
	} {
		if _, err := ParseCSV(c.vendor, c.kind, strings.NewReader(c.in)); err == nil {
			t.Errorf("%s %s %q accepted", c.vendor, c.kind, c.in)
		}
	}
}
