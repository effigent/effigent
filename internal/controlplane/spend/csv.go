package spend

import (
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// CSV imports, for workspaces that can't (or won't) give us an admin key:
// GitHub's Copilot seat export, Cursor's members export and Cursor's usage
// export. Exports change their columns from time to time, so columns are
// found by name (case-insensitive, any of several spellings), not position.

// CSV kinds.
const (
	CSVSeats = "seats"
	CSVUsage = "usage"
)

// MaxCSVRows bounds one import.
const MaxCSVRows = 200_000

// CSVResult is what an import found.
type CSVResult struct {
	Seats    []Seat     `json:"-"`
	Usage    []UsageDay `json:"-"`
	Rows     int        `json:"rows"`
	Skipped  int        `json:"skipped"`
	Warnings []string   `json:"warnings,omitempty"`
}

var csvCols = map[string][]string{
	"login":    {"login", "github login", "assignee", "assignee login", "github username", "username", "user login"},
	"email":    {"email", "user email", "useremail", "email address", "member email"},
	"user":     {"user", "member"},
	"name":     {"name", "full name", "display name"},
	"plan":     {"plan", "plan type", "plan_type", "role", "seat type"},
	"price":    {"price", "seat price", "monthly price", "seat cost", "cost per seat"},
	"activity": {"last activity at", "last_activity_at", "last activity", "last active", "last used", "last used at", "last authenticated at"},
	"created":  {"created at", "created_at", "assigned at", "added at", "date added"},
	"date":     {"date", "day", "timestamp", "time", "usage date"},
	"cost":     {"cost", "charged", "charged cents", "chargedcents", "amount", "spend", "cost (usd)", "total cost", "spend cents"},
	"requests": {"requests", "request count", "requests count", "num requests", "count"},
	"tokens":   {"tokens", "total tokens"},
}

// bom starts files saved by Excel and some exports.
var bom = string(rune(0xFEFF))

func normHeader(h string) string {
	h = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(h, bom)))
	return strings.Join(strings.Fields(strings.NewReplacer("_", " ", "-", " ").Replace(h)), " ")
}

// ParseCSV reads one export for a vendor. kind is CSVSeats or CSVUsage.
func ParseCSV(vendor, kind string, r io.Reader) (CSVResult, error) {
	var out CSVResult
	if !IsVendor(vendor) {
		return out, fmt.Errorf("unknown vendor %q", vendor)
	}
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	cr.TrimLeadingSpace = true
	cr.LazyQuotes = true
	head, err := cr.Read()
	if err != nil {
		return out, errors.New("the file is empty or isn't CSV")
	}
	col := map[string]int{}
	for i, h := range head {
		n := normHeader(h)
		for field, names := range csvCols {
			if _, ok := col[field]; ok {
				continue
			}
			for _, x := range names {
				if n == normHeader(x) {
					col[field] = i
				}
			}
		}
	}
	get := func(rec []string, f string) string {
		if i, ok := col[f]; ok && i < len(rec) {
			return strings.TrimSpace(rec[i])
		}
		return ""
	}
	identity := func(rec []string) string {
		if vendor == Copilot {
			if v := get(rec, "login"); v != "" {
				return strings.ToLower(v)
			}
		}
		for _, f := range []string{"email", "user", "login"} {
			if v := get(rec, f); v != "" {
				return strings.ToLower(v)
			}
		}
		return ""
	}
	_, hasID := col["email"]
	if _, ok := col["login"]; ok {
		hasID = true
	}
	if _, ok := col["user"]; ok {
		hasID = true
	}
	if !hasID {
		return out, fmt.Errorf("no user column found (looked for email, login, user) in: %s", strings.Join(head, ", "))
	}
	acc := newAcc(vendor)
	switch kind {
	case CSVSeats:
	case CSVUsage:
		if _, ok := col["date"]; !ok {
			return out, fmt.Errorf("a usage export needs a date column; found: %s", strings.Join(head, ", "))
		}
	default:
		return out, fmt.Errorf("kind must be %q or %q", CSVSeats, CSVUsage)
	}
	costInCents := false
	if i, ok := col["cost"]; ok {
		costInCents = strings.Contains(normHeader(head[i]), "cents")
	}
	seen := map[string]bool{}
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return out, fmt.Errorf("line %d: %v", out.Rows+2, err)
		}
		out.Rows++
		if out.Rows > MaxCSVRows {
			return out, fmt.Errorf("more than %d rows; split the export", MaxCSVRows)
		}
		id := identity(rec)
		if id == "" {
			out.Skipped++
			continue
		}
		switch kind {
		case CSVSeats:
			if seen[id] {
				out.Skipped++
				continue
			}
			seen[id] = true
			s := Seat{Vendor: vendor, Identity: id, Name: get(rec, "name"), Plan: strings.ToLower(get(rec, "plan")), Source: "csv"}
			if v := get(rec, "price"); v != "" {
				if d, ok := parseMoney(v, false); ok {
					s.PriceCents = d
				}
			}
			if t, ok := parseCSVTime(get(rec, "activity")); ok {
				s.LastActivity = &t
			}
			if t, ok := parseCSVTime(get(rec, "created")); ok {
				s.AssignedAt = &t
			}
			out.Seats = append(out.Seats, s)
		case CSVUsage:
			t, ok := parseCSVTime(get(rec, "date"))
			if !ok {
				out.Skipped++
				continue
			}
			row := acc.at(id, t)
			row.Source = "csv"
			if c, ok := parseMoney(get(rec, "cost"), costInCents); ok {
				row.CostCents += c
			}
			if n, err := strconv.ParseInt(strings.ReplaceAll(get(rec, "requests"), ",", ""), 10, 64); err == nil && n > 0 {
				row.Requests += n
			} else if _, has := col["requests"]; !has {
				row.Requests++ // one row per request/event
			}
			if n, err := strconv.ParseInt(strings.ReplaceAll(get(rec, "tokens"), ",", ""), 10, 64); err == nil {
				row.Tokens += n
			}
		}
	}
	out.Usage = acc.list()
	if out.Skipped > 0 {
		out.Warnings = append(out.Warnings, fmt.Sprintf("%d rows had no user or date and were skipped", out.Skipped))
	}
	if len(out.Seats) == 0 && len(out.Usage) == 0 {
		return out, errors.New("no usable rows in the file")
	}
	return out, nil
}

// parseMoney reads "$1,234.50", "1234.5" (dollars) or cents when inCents.
func parseMoney(s string, inCents bool) (int64, bool) {
	s = strings.TrimSpace(strings.NewReplacer("$", "", ",", "", "USD", "", "usd", "").Replace(s))
	if s == "" || s == "-" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	if inCents {
		return cents(v), true
	}
	return cents(v * 100), true
}

func parseCSVTime(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" || strings.EqualFold(s, "never") || strings.EqualFold(s, "null") {
		return time.Time{}, false
	}
	if ms, err := strconv.ParseInt(s, 10, 64); err == nil && ms > 1e9 {
		if ms < 1e11 {
			ms *= 1000
		}
		return time.UnixMilli(ms).UTC(), true
	}
	for _, l := range []string{time.RFC3339Nano, "2006-01-02 15:04:05 MST", "2006-01-02 15:04:05 -0700", "2006-01-02 15:04:05", "2006-01-02T15:04:05", "2006-01-02", "01/02/2006", "Jan 2, 2006", "Jan 2, 2006, 3:04 PM"} {
		if t, err := time.Parse(l, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}
