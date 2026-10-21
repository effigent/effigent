package hooks

import (
	"net/url"
	"path"
	"regexp"
	"strings"

	"github.com/effigent/effigent/internal/endpoint/event"
)

var dbClients = map[string]bool{"psql": true, "pgcli": true, "mysql": true, "mariadb": true, "mycli": true, "sqlite3": true,
	"mongosh": true, "mongo": true, "redis-cli": true, "valkey-cli": true, "sqlcmd": true, "clickhouse-client": true,
	"clickhouse": true, "cockroach": true, "snowsql": true, "bq": true, "duckdb": true, "cqlsh": true}

// sql classifies a database client call: the statements it runs (-c, -e,
// a heredoc, a piped echo, a .sql file) and the host it reaches.
func (x *actx) sql(cmds []simpleCmd, i int, prog string, rest []string, env map[string]string) {
	attrs := map[string]string{"client": prog}
	var texts []string
	var files []string
	switch prog {
	case "psql", "pgcli":
		texts = flagValues(rest, "-c", "--command")
		files = flagValues(rest, "-f", "--file")
		host, _ := flagValue(rest, "-h", "--host")
		db, _ := flagValue(rest, "-d", "--dbname")
		if p := positional(rest, map[string]bool{"-c": true, "--command": true, "-f": true, "--file": true, "-h": true, "--host": true,
			"-d": true, "--dbname": true, "-U": true, "--username": true, "-p": true, "--port": true, "-v": true, "--set": true,
			"-o": true, "--output": true, "-F": true, "-R": true, "-P": true}); len(p) > 0 && db == "" {
			db = p[0]
		}
		x.dbTarget(attrs, host, db, env, "PGHOST", "localhost")
	case "mysql", "mariadb", "mycli":
		texts = flagValues(rest, "-e", "--execute")
		host, _ := flagValue(rest, "-h", "--host")
		for _, a := range rest {
			if h, ok := strings.CutPrefix(a, "-h"); ok && h != "" && host == "" {
				host = h
			}
		}
		x.dbTarget(attrs, host, "", env, "MYSQL_HOST", "localhost")
	case "sqlite3", "duckdb":
		p := positional(rest, map[string]bool{"-cmd": true, "-separator": true, "-nullvalue": true})
		if len(p) > 0 {
			attrs["db_file"] = resolveIn(p[0], x.cwd, x.home)
			texts = p[1:]
		}
		texts = append(texts, flagValues(rest, "-cmd")...)
	case "mongosh", "mongo":
		texts = flagValues(rest, "--eval")
		files = flagValues(rest, "-f", "--file")
		host, _ := flagValue(rest, "--host")
		uri := ""
		if p := positional(rest, map[string]bool{"--eval": true, "--host": true, "--port": true, "-u": true, "--username": true,
			"-p": true, "--password": true, "-f": true, "--file": true, "--authenticationDatabase": true}); len(p) > 0 {
			uri = p[0]
		}
		x.dbTarget(attrs, host, uri, env, "", "localhost")
	case "redis-cli", "valkey-cli":
		host, _ := flagValue(rest, "-h")
		uri, _ := flagValue(rest, "-u")
		x.dbTarget(attrs, host, uri, env, "", "localhost")
		if p := positional(rest, map[string]bool{"-h": true, "-p": true, "-a": true, "-u": true, "-n": true, "--user": true, "--pass": true, "-r": true, "-i": true}); len(p) > 0 {
			texts = append(texts, strings.Join(p, " "))
		}
	case "sqlcmd":
		texts = flagValues(rest, "-Q", "-q", "--query")
		files = flagValues(rest, "-i", "--input-file")
		host, _ := flagValue(rest, "-S", "--server")
		x.dbTarget(attrs, host, "", env, "SQLCMDSERVER", "localhost")
	case "clickhouse-client", "clickhouse":
		texts = flagValues(rest, "-q", "--query")
		files = flagValues(rest, "--queries-file")
		host, _ := flagValue(rest, "-h", "--host")
		x.dbTarget(attrs, host, "", env, "CLICKHOUSE_HOST", "localhost")
	case "cockroach":
		texts = flagValues(rest, "-e", "--execute")
		host, _ := flagValue(rest, "--host")
		uri, _ := flagValue(rest, "--url")
		x.dbTarget(attrs, host, uri, env, "COCKROACH_HOST", "localhost")
	case "snowsql":
		texts = flagValues(rest, "-q", "--query")
		files = flagValues(rest, "-f", "--filename")
		if a, ok := flagValue(rest, "-a", "--accountname"); ok {
			attrs["db_host"] = strings.ToLower(a) + ".snowflakecomputing.com"
		} else {
			attrs["target"] = "unknown"
		}
	case "bq":
		attrs["db_host"] = "bigquery.googleapis.com"
		if p, ok := flagValue(rest, "--project_id"); ok {
			attrs["gcloud_project"] = p
		}
		p := positional(rest, map[string]bool{"--project_id": true, "--location": true, "--format": true, "--dataset_id": true})
		if len(p) > 0 {
			switch p[0] {
			case "query":
				texts = p[1:]
			case "rm":
				x.add(event.Action{Kind: "destructive_sql", Target: "bq " + strings.Join(p, " "), Attrs: attrs})
				return
			case "mk", "load", "insert", "update", "cp":
				x.add(event.Action{Kind: "sql_write", Target: "bq " + strings.Join(p, " "), Attrs: attrs})
				return
			}
		}
	case "cqlsh":
		texts = flagValues(rest, "-e", "--execute")
		files = flagValues(rest, "-f", "--file")
		host := ""
		if p := positional(rest, map[string]bool{"-e": true, "--execute": true, "-f": true, "--file": true, "-u": true, "-p": true, "-k": true}); len(p) > 0 {
			host = p[0]
		}
		x.dbTarget(attrs, host, "", env, "", "localhost")
	}
	c := cmds[i]
	texts = append(texts, c.stdin...)
	files = append(files, c.inputs...)
	if c.pipeFrom > 0 && c.pipeFrom <= len(cmds) {
		src := program(cmds[c.pipeFrom-1].args)
		if len(src) > 1 {
			switch progName(src[0]) {
			case "echo", "printf":
				texts = append(texts, strings.Join(positional(src[1:], nil), " "))
			case "cat", "zcat", "gunzip":
				files = append(files, positional(src[1:], nil)...)
			}
		}
	}
	for _, f := range files {
		if f == "-" {
			continue
		}
		if body := readUserText(x.in, resolveIn(f, x.cwd, x.home)); body != "" {
			texts = append(texts, body)
		} else {
			// an unread file may hold anything
			x.add(event.Action{Kind: "sql_write", Target: "statements in " + path.Base(f), Attrs: withAttr(attrs, "unread", "true")})
		}
	}
	wrote := false
	for _, t := range texts {
		for _, st := range statements(t) {
			if k := sqlKind(prog, st); k != "" {
				x.add(event.Action{Kind: k, Target: st, Attrs: attrs})
				wrote = true
			}
		}
	}
	if !wrote {
		x.add(event.Action{Kind: "access", Target: prog + " " + firstNonEmpty(attrs["db_host"], attrs["db_file"]), Attrs: attrs})
	}
}

// dbTarget sets db_host from a host flag, a connection URL, an environment
// variable, or the client's default.
func (x *actx) dbTarget(attrs map[string]string, host, uri string, env map[string]string, envVar, def string) {
	host, ok := expandVars(host, env, x.in.Env)
	if !ok {
		host = ""
	}
	if uri != "" {
		if u, okU := expandVars(uri, env, x.in.Env); okU {
			if h := urlHost(u); h != "" && host == "" {
				host = h
			}
		} else if host == "" {
			attrs["target"] = "unknown"
			return
		}
	}
	if host == "" && envVar != "" {
		host = x.getenv(env, envVar)
	}
	if host == "" {
		host = def
	}
	if strings.HasPrefix(host, "/") {
		host = "localhost" // a Unix socket directory
	}
	attrs["db_host"] = strings.ToLower(host)
}

// urlHost is the host of a connection URL ("" if it isn't one).
func urlHost(s string) string {
	if !strings.Contains(s, "://") {
		return ""
	}
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	h := u.Hostname()
	if h == "" {
		if q := u.Query().Get("host"); q != "" && !strings.HasPrefix(q, "/") {
			return q
		}
		return "localhost"
	}
	return strings.ToLower(h)
}

func firstNonEmpty(s ...string) string {
	for _, v := range s {
		if v != "" {
			return v
		}
	}
	return ""
}

// flagValues returns every value of the named flags ("-c a -c b", "--command=a").
func flagValues(args []string, names ...string) []string {
	var out []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			break
		}
		for _, n := range names {
			if a == n && i+1 < len(args) {
				out = append(out, args[i+1])
				i++
				break
			}
			if v, ok := strings.CutPrefix(a, n+"="); ok && strings.HasPrefix(n, "--") {
				out = append(out, v)
				break
			}
		}
	}
	return out
}

var (
	sqlCommentRE = regexp.MustCompile(`(?s)/\*.*?\*/|--[^\n]*`)
	sqlStringRE  = regexp.MustCompile(`'(?:[^']|'')*'`)
	sqlSpaceRE   = regexp.MustCompile(`\s+`)
)

// statements splits SQL text into statements, comments removed and
// whitespace collapsed (strings kept, a ; inside one doesn't split).
func statements(t string) []string {
	t = sqlCommentRE.ReplaceAllString(t, " ")
	var out []string
	var b strings.Builder
	inStr := false
	for _, r := range t {
		switch {
		case r == '\'':
			inStr = !inStr
		case r == ';' && !inStr:
			if s := strings.TrimSpace(sqlSpaceRE.ReplaceAllString(b.String(), " ")); s != "" {
				out = append(out, s)
			}
			b.Reset()
			continue
		}
		b.WriteRune(r)
	}
	if s := strings.TrimSpace(sqlSpaceRE.ReplaceAllString(b.String(), " ")); s != "" {
		out = append(out, s)
	}
	return out
}

var (
	sqlDestroyRE   = regexp.MustCompile(`(?i)^(drop\s+(table|database|schema|index|view|materialized\s+view|function|procedure|trigger|sequence|type|extension|role|user|owned|keyspace|column|policy|collection|stage|warehouse)\b|truncate\b|alter\s+table\b.*\bdrop\b|delete\s+from\s+\S+\s*$)`)
	sqlUpdateRE    = regexp.MustCompile(`(?i)^update\s+\S+\s+set\b`)
	sqlWhereRE     = regexp.MustCompile(`(?i)\bwhere\b`)
	sqlWriteRE     = regexp.MustCompile(`(?i)^(with\b.*\b(insert|update|delete|merge)\b|insert|update|delete|merge|upsert|replace|create|alter|drop|truncate|grant|revoke|rename|copy\s+\S+\s+from|comment\s+on|call|exec|execute|do|vacuum\s+full|cluster|reindex|refresh\s+materialized|load\s+data|attach|detach|import)\b`)
	mongoDestroyRE = regexp.MustCompile(`\.(dropDatabase|drop|deleteMany\(\s*\{\s*\}|remove\(\s*\{\s*\})`)
	mongoWriteRE   = regexp.MustCompile(`\.(insert\w*|update\w*|replace\w*|delete\w*|remove|findOneAnd\w*|bulkWrite|createCollection|createIndex\w*|dropIndex\w*|renameCollection|aggregate\(.*\$(out|merge))\b`)
	redisDestroy   = map[string]bool{"flushall": true, "flushdb": true, "unlink": true, "del": true, "config": true}
	redisWrite     = map[string]bool{"set": true, "setex": true, "mset": true, "hset": true, "hdel": true, "lpush": true, "rpush": true,
		"sadd": true, "srem": true, "zadd": true, "zrem": true, "expire": true, "rename": true, "incr": true, "decr": true,
		"lpop": true, "rpop": true, "xadd": true, "restore": true, "migrate": true, "eval": true, "evalsha": true, "fcall": true,
		"script": true, "persist": true, "copy": true, "move": true, "swapdb": true, "hincrby": true, "incrby": true, "append": true}
)

// sqlKind: destructive_sql, sql_write, or "" for a read.
func sqlKind(client, st string) string {
	switch client {
	case "mongosh", "mongo":
		switch {
		case mongoDestroyRE.MatchString(st):
			return "destructive_sql"
		case mongoWriteRE.MatchString(st):
			return "sql_write"
		}
		return ""
	case "redis-cli", "valkey-cli":
		w, _, _ := strings.Cut(strings.ToLower(st), " ")
		switch {
		case w == "flushall" || w == "flushdb" || w == "swapdb":
			return "destructive_sql"
		case redisDestroy[w] || redisWrite[w]:
			return "sql_write"
		}
		return ""
	}
	bare := sqlStringRE.ReplaceAllString(st, "''")
	switch {
	case sqlDestroyRE.MatchString(bare) || sqlUpdateRE.MatchString(bare) && !sqlWhereRE.MatchString(bare):
		return "destructive_sql"
	case sqlWriteRE.MatchString(bare):
		return "sql_write"
	}
	return ""
}

// migration tools: running migrations is sql_write, resetting or dropping
// a database destructive_sql. The target is DATABASE_URL's host when the
// agent's environment (or the command) names one.
func (x *actx) migration(line string, env map[string]string) {
	kind := ""
	m := ""
	for _, r := range migrationRules {
		if s := r.re.FindString(line); s != "" {
			kind, m = r.kind, s
			if kind == "destructive_sql" {
				break
			}
		}
	}
	if kind == "" {
		return
	}
	attrs := map[string]string{"tool": "migration"}
	if h := urlHost(x.getenv(env, "DATABASE_URL")); h != "" {
		attrs["db_host"] = h
	} else {
		attrs["target"] = "unknown"
	}
	x.add(event.Action{Kind: kind, Target: m, Attrs: attrs})
}

var migrationRules = []struct {
	re   *regexp.Regexp
	kind string
}{
	{regexp.MustCompile(`\bprisma (migrate reset|db push\b.*--(accept-data-loss|force-reset))`), "destructive_sql"},
	{regexp.MustCompile(`\bprisma (migrate (dev|deploy|resolve)|db (push|execute|seed))\b`), "sql_write"},
	{regexp.MustCompile(`\b(rails|rake|bin/rails) db:(drop|reset|schema:load|structure:load|purge|truncate_all|rollback|migrate:reset)\b`), "destructive_sql"},
	{regexp.MustCompile(`\b(rails|rake|bin/rails) db:(migrate|setup|seed|prepare|create)\b`), "sql_write"},
	{regexp.MustCompile(`\bmanage\.py (flush|sqlflush|reset_db|migrate \S+ zero)\b`), "destructive_sql"},
	{regexp.MustCompile(`\bmanage\.py (migrate|loaddata|createsuperuser)\b`), "sql_write"},
	{regexp.MustCompile(`\balembic (downgrade)\b`), "destructive_sql"},
	{regexp.MustCompile(`\balembic (upgrade|stamp)\b`), "sql_write"},
	{regexp.MustCompile(`\b(knex|sequelize|sequelize-cli) (migrate:rollback|db:migrate:undo(:all)?|db:drop|migrate:down)\b`), "destructive_sql"},
	{regexp.MustCompile(`\b(knex|sequelize|sequelize-cli) (migrate:latest|migrate:up|db:migrate|db:seed(:all)?|seed:run)\b`), "sql_write"},
	{regexp.MustCompile(`\b(flyway (clean|undo)|liquibase (drop-?all|rollback\S*)|goose \S+ \S+ (down|reset|down-to)|goose (down|reset|down-to)|dbmate (drop|down|rollback)|migrate .*\b(down|drop)\b|typeorm (schema:drop|migration:revert)|supabase db reset|drizzle-kit drop|atlas schema clean|sqitch revert)\b`), "destructive_sql"},
	{regexp.MustCompile(`\b(flyway (migrate|repair|baseline)|liquibase update\S*|goose (\S+ \S+ )?(up|up-by-one|up-to)|dbmate (up|migrate|create)|migrate .*\bup\b|typeorm (migration:run|schema:sync)|supabase (db push|migration up)|drizzle-kit (push|migrate)|atlas (schema apply|migrate apply)|sqitch deploy|diesel migration (run|redo)|sqlx migrate run|mikro-orm (migration:up|schema:update))\b`), "sql_write"},
}
