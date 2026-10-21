package hooks

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/effigent/effigent/internal/endpoint/event"
)

// SQL and database operations inside MCP tool calls. Server names are the
// user's own keys in the agent's MCP config, so a call is read as a database
// call only when the tool name says it runs SQL (execute_sql, run_sql, …) or
// the server name looks like a database and the tool is a query tool. The
// statement comes from the argument names the popular servers use (checked
// against their sources, 2026-10-21):
//   - sql: @modelcontextprotocol/server-postgres `query`, Google MCP Toolbox
//     `execute_sql`, benborla/mcp-server-mysql `mysql_query`, bytebase/dbhub
//     `execute_sql[_<source>]`, Neon (hosted) `run_sql` / `explain_sql_statement`
//   - query: mcp-server-sqlite `read_query`/`write_query`, Supabase `execute_sql`
//     / `apply_migration`, designcomputer/mysql_mcp_server `execute_sql`,
//     ClickHouse `run_query`, mcp-server-bigquery `execute-query`
//   - statement: Snowflake-Labs/mcp `run_snowflake_query`
//   - sql_statements / migration_sql (Neon hosted), params.{sql, sqlStatements,
//     migrationSql} (Neon npm, nested under params)
//
// MongoDB (mongodb-js/mongodb-mcp-server) and Redis (redis/mcp-redis) tools
// have no SQL: they are classified by tool name.

var (
	dbServerRE = regexp.MustCompile(`postgres|psql|mysql|maria|sqlite|supabase|neon|bigquery|snowflake|clickhouse|mongo|redis|valkey|` +
		`dbhub|database|sql|cockroach|planetscale|turso|libsql|duckdb|oracle|spanner|alloydb|toolbox|prisma|cassandra|dynamo|` +
		`(^|[^a-z])(pg|db|bq)([^a-z]|$)`)
	// tools that say they run SQL, on any server (the input must also carry SQL)
	sqlToolRE = regexp.MustCompile(`(?i)sql`)
	// generic query tools: SQL only on a database-looking server
	queryToolRE = regexp.MustCompile(`(?i)^(query|run_query|execute_query|execute-query|read_query|write_query|run_select_query|` +
		`mysql_query|run_snowflake_query|query_database|execute|run|apply_migration|prepare_database_migration|execute_write_query|` +
		`execute_read_query|planetscale_execute_read_query|planetscale_execute_write_query)$`)
	// tools on a database server that delete a database, branch or project
	dbDestroyToolRE = regexp.MustCompile(`(?i)^(delete|drop|reset|truncate|purge)[_-]|^(reset_from_parent|restore_snapshot|restore_project)$`)
	sqlArgs         = []string{"sql", "query", "statement", "sql_statements", "sqlStatements", "migration_sql", "migrationSql", "sql_query", "statements"}
	mongoDestroy    = map[string]bool{"drop-database": true, "drop-collection": true, "delete-many": true}
	mongoWrite      = map[string]bool{"insert-many": true, "update-many": true, "rename-collection": true, "create-collection": true,
		"create-index": true, "drop-index": true, "insert-one": true, "update-one": true, "delete-one": true}
	redisMCPWrite = map[string]bool{"set": true, "hset": true, "hdel": true, "delete": true, "rename": true, "expire": true,
		"json_set": true, "json_del": true, "lpush": true, "rpush": true, "lpop": true, "rpop": true, "lrem": true, "sadd": true,
		"srem": true, "zadd": true, "zrem": true, "xadd": true, "xdel": true, "xgroup_create": true, "xgroup_destroy": true,
		"set_vector_in_hash": true, "create_vector_index_hash": true}
)

// mcpDatabase classifies a database MCP call; false when the call isn't one.
func (x *actx) mcpDatabase(server, tool string, input map[string]any) bool {
	_, name, _ := strings.Cut(strings.TrimPrefix(tool, "mcp__"), "__")
	dbServer := dbServerRE.MatchString(server)
	attrs := map[string]string{"mcp_server": server, "tool": name, "client": "mcp"}
	add := func(kind, target string) { x.add(event.Action{Kind: kind, Target: target, Attrs: attrs}) }
	lname := strings.ToLower(name)

	switch {
	case strings.Contains(server, "mongo") || mongoDestroy[lname] || mongoWrite[lname]:
		target := strings.TrimSpace(name + " " + str(input, "database") + " " + str(input, "collection"))
		switch {
		case mongoDestroy[lname]:
			if lname == "delete-many" && !emptyFilter(input["filter"]) {
				add("sql_write", target)
			} else {
				add("destructive_sql", target)
			}
			return true
		case mongoWrite[lname]:
			add("sql_write", target)
			return true
		case lname == "aggregate" || lname == "aggregate-db":
			if b, _ := json.Marshal(input["pipeline"]); strings.Contains(string(b), `"$out"`) || strings.Contains(string(b), `"$merge"`) {
				add("sql_write", target)
				return true
			}
		}
		if strings.Contains(server, "mongo") {
			add("access", target)
			return true
		}
	case strings.Contains(server, "redis") || strings.Contains(server, "valkey"):
		if cmd := firstString(input, "command", "cmd"); cmd != "" {
			if k := sqlKind("redis-cli", cmd); k != "" {
				add(k, cmd)
			} else {
				add("access", cmd)
			}
			return true
		}
		key := firstString(input, "key", "name", "old_key")
		if redisMCPWrite[lname] {
			add("sql_write", strings.TrimSpace(name+" "+key))
		} else {
			add("access", strings.TrimSpace(name+" "+key))
		}
		return true
	}

	if dbServer && dbDestroyToolRE.MatchString(name) {
		add("destructive_sql", name+" "+firstString(input, "branch_id", "branchId", "project_id", "projectId", "database_name", "databaseName", "name"))
		return true
	}
	if !sqlToolRE.MatchString(name) && !(dbServer && queryToolRE.MatchString(name)) {
		return false
	}
	texts := sqlTexts(input)
	if len(texts) == 0 {
		return false
	}
	wrote := false
	var first string
	for _, t := range texts {
		for _, st := range statements(t) {
			if first == "" {
				first = st
			}
			if k := sqlKind("", st); k != "" {
				add(k, st)
				wrote = true
			}
		}
	}
	if !wrote && first != "" {
		add("access", first)
	}
	return first != ""
}

// sqlTexts takes the SQL from the argument names database servers use
// (strings, lists of strings, or nested under params).
func sqlTexts(input map[string]any) []string {
	var out []string
	for _, m := range []map[string]any{input, asMap(input["params"]), asMap(input["arguments"])} {
		for _, k := range sqlArgs {
			switch v := m[k].(type) {
			case string:
				if strings.TrimSpace(v) != "" {
					out = append(out, v)
				}
			case []any:
				for _, e := range v {
					if s, ok := e.(string); ok && strings.TrimSpace(s) != "" {
						out = append(out, s)
					}
				}
			}
		}
	}
	return out
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if s := str(m, k); s != "" {
			return s
		}
	}
	return ""
}

// emptyFilter: a Mongo filter that matches every document.
func emptyFilter(v any) bool {
	switch f := v.(type) {
	case nil:
		return true
	case map[string]any:
		return len(f) == 0
	case string:
		s := strings.TrimSpace(f)
		return s == "" || s == "{}"
	}
	return false
}
