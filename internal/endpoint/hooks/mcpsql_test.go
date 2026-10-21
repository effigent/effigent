package hooks

import (
	"strings"
	"testing"

	"github.com/effigent/effigent/internal/endpoint/policy"
)

func TestMCPDatabase(t *testing.T) {
	rule := policy.Rule{Mode: policy.Denylist, Environments: prodEnv()} // prod: mcp_servers [prod-db]
	call := func(tool string, input map[string]any) []string {
		return kinds(classify(rule, ClaudeInput{ToolName: tool, ToolInput: input}).actions)
	}
	cases := []struct {
		name  string
		tool  string
		input map[string]any
		want  []string // prefix matches
		not   []string
	}{
		{"postgres server query", "mcp__postgres__query", map[string]any{"sql": "DROP TABLE users"}, []string{"destructive_sql DROP TABLE users"}, nil},
		{"prod env by server name", "mcp__prod-db__query", map[string]any{"sql": "delete from orders"}, []string{"destructive_sql delete from orders @prod"}, nil},
		{"read on prod is access@prod", "mcp__prod-db__query", map[string]any{"sql": "select * from orders"}, []string{"access select * from orders @prod"}, []string{"sql_write"}},
		{"supabase execute_sql", "mcp__supabase__execute_sql", map[string]any{"project_id": "abc", "query": "update users set admin = true"}, []string{"destructive_sql update users set admin = true"}, nil},
		{"supabase migration", "mcp__supabase__apply_migration", map[string]any{"name": "m1", "query": "create table t (id int)"}, []string{"sql_write create table t"}, []string{"destructive_sql"}},
		{"neon hosted transaction", "mcp__neon__run_sql_transaction", map[string]any{"sql_statements": []any{"insert into t values (1)", "truncate t2"}},
			[]string{"sql_write insert into t values (1)", "destructive_sql truncate t2"}, nil},
		{"neon npm params", "mcp__neon__run_sql", map[string]any{"params": map[string]any{"sql": "drop schema app cascade", "projectId": "p"}}, []string{"destructive_sql drop schema app cascade"}, nil},
		{"neon delete branch", "mcp__neon__delete_branch", map[string]any{"project_id": "p", "branch_id": "br-1"}, []string{"destructive_sql delete_branch br-1"}, nil},
		{"snowflake statement", "mcp__snowflake__run_snowflake_query", map[string]any{"statement": "DELETE FROM sales"}, []string{"destructive_sql DELETE FROM sales"}, nil},
		{"sqlite write_query", "mcp__sqlite__write_query", map[string]any{"query": "INSERT INTO a VALUES (1)"}, []string{"sql_write INSERT INTO a"}, nil},
		{"clickhouse run_query", "mcp__clickhouse__run_query", map[string]any{"query": "SELECT 1"}, []string{"access SELECT 1"}, nil},
		{"dbhub per-source tool", "mcp__dbhub__execute_sql_prod", map[string]any{"sql": "alter table t drop column c"}, []string{"destructive_sql alter table t drop column c"}, nil},
		{"any server, sql tool", "mcp__acme-internal__execute_sql", map[string]any{"sql": "grant all on t to bob"}, []string{"sql_write grant all"}, nil},
		{"mongo drop", "mcp__mongodb__drop-collection", map[string]any{"database": "app", "collection": "users"}, []string{"destructive_sql drop-collection app users"}, nil},
		{"mongo delete all", "mcp__mongodb__delete-many", map[string]any{"database": "app", "collection": "users", "filter": map[string]any{}}, []string{"destructive_sql delete-many"}, nil},
		{"mongo delete filtered", "mcp__mongodb__delete-many", map[string]any{"database": "app", "collection": "users", "filter": map[string]any{"x": 1}}, []string{"sql_write delete-many"}, []string{"destructive_sql"}},
		{"mongo aggregate $out", "mcp__mongodb__aggregate", map[string]any{"pipeline": []any{map[string]any{"$out": "copy"}}}, []string{"sql_write aggregate"}, nil},
		{"mongo find", "mcp__mongodb__find", map[string]any{"database": "app", "collection": "users"}, []string{"access find app users"}, []string{"sql_write"}},
		{"redis set", "mcp__redis__set", map[string]any{"key": "k", "value": "v"}, []string{"sql_write set k"}, nil},
		{"redis get", "mcp__redis__get", map[string]any{"key": "k"}, []string{"access get k"}, []string{"sql_write"}},
		{"ticket tool not sql", "mcp__linear__create_issue", map[string]any{"title": "create table for reports", "query": "drop it"}, nil, []string{"sql_write", "destructive_sql", "access"}},
		{"search query not sql", "mcp__github__search_code", map[string]any{"query": "delete from users"}, nil, []string{"destructive_sql", "sql_write"}},
		{"feedback server is not a db", "mcp__feedback__query", map[string]any{"query": "update everything"}, nil, []string{"destructive_sql", "sql_write"}},
	}
	for _, c := range cases {
		got := call(c.tool, c.input)
		for _, w := range c.want {
			if !hasPrefix(got, w) {
				t.Errorf("%s: want %q in %v", c.name, w, got)
			}
		}
		for _, n := range c.not {
			if hasPrefix(got, n) {
				t.Errorf("%s: unexpected %q in %v", c.name, n, got)
			}
		}
	}
}

func hasPrefix(list []string, p string) bool {
	for _, s := range list {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

func TestMCPDatabaseDecision(t *testing.T) {
	rule := policy.Rule{Mode: policy.Denylist, Environments: prodEnv(), ActionsDeny: []string{"destructive_sql@prod"}, ActionsApprove: []string{"sql_write"}}
	d := EvaluateClaude(rule, ClaudeInput{ToolName: "mcp__prod-db__query", ToolInput: map[string]any{"sql": "DROP TABLE users"}})
	if !d.Deny || d.Rule != "actions_deny" || !strings.Contains(d.Reason, "DROP TABLE users") {
		t.Errorf("prod drop: %+v", d)
	}
	d = EvaluateClaude(rule, ClaudeInput{ToolName: "mcp__postgres__query", ToolInput: map[string]any{"sql": "insert into t values (1)"}})
	if !d.Approve || d.Rule != "actions_approve" {
		t.Errorf("write: %+v", d)
	}
	d = EvaluateClaude(rule, ClaudeInput{ToolName: "mcp__postgres__query", ToolInput: map[string]any{"sql": "select 1"}})
	if d.Deny || d.Approve {
		t.Errorf("read: %+v", d)
	}
}
