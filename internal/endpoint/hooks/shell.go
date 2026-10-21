package hooks

import (
	"path"
	"strings"
)

// simpleCmd is one command of a shell line: its words with quotes removed,
// and the files it redirects to or from.
type simpleCmd struct {
	args      []string
	redirects []string // every redirect target, in and out
	inputs    []string // files read on stdin (< file)
	stdin     []string // text fed on stdin: heredoc bodies and here-strings
	pipeFrom  int      // 1 + index of the command whose output it reads (a | b), 0 if none
	from      string   // the script it was read from (expandScripts), "" for the command line
}

// splitShell splits a shell command line into its simple commands. It is a
// deliberately small reading of shell syntax: quotes, backslashes, the usual
// separators (; & | && || newlines, subshells), redirections, $( ) and
// backticks, also inside double quotes, and heredocs (a body is a script only
// when a shell reads it; otherwise it is data, and only its substitutions run
// when the delimiter is unquoted). Commands passed to `sh -c` / `eval` are
// read too. Anything it can't follow (variables, aliases, functions,
// scripts) it leaves alone.
func splitShell(s string) []simpleCmd { return splitDepth(s, 0) }

func splitDepth(s string, depth int) []simpleCmd {
	if depth > 4 {
		return nil
	}
	var (
		out      []simpleCmd
		cur      simpleCmd
		w        strings.Builder
		inWord   bool
		redirect bool
		readIn   bool      // the redirect is < (a file read on stdin)
		hereStr  bool      // the next word is a here-string
		pipe     int       // pipeFrom for the next command
		pending  []heredoc // heredocs whose bodies start after this line
	)
	flushWord := func() {
		if !inWord {
			return
		}
		switch {
		case redirect:
			cur.redirects = append(cur.redirects, w.String())
			if readIn {
				cur.inputs = append(cur.inputs, w.String())
			}
			redirect, readIn = false, false
		default:
			if hereStr {
				cur.stdin = append(cur.stdin, w.String())
				hereStr = false
			}
			cur.args = append(cur.args, w.String())
		}
		w.Reset()
		inWord = false
	}
	flushCmd := func() {
		flushWord()
		redirect, readIn, hereStr = false, false, false
		if len(cur.args) > 0 || len(cur.redirects) > 0 {
			cur.pipeFrom = pipe
			out = append(out, cur)
		}
		pipe = 0
		cur = simpleCmd{}
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\n' && len(pending) > 0:
			flushCmd()
			for _, h := range pending {
				body, next := heredocBody(s, i+1, h)
				if h.owner < len(out) {
					out[h.owner].stdin = append(out[h.owner].stdin, body)
				}
				out = append(out, h.commands(body, out, depth)...)
				i = next - 1
			}
			pending = nil
		case c == '<' && strings.HasPrefix(s[i:], "<<") && !strings.HasPrefix(s[i:], "<<<"):
			flushWord()
			h := heredoc{owner: len(out)}
			i += 2
			if i < len(s) && s[i] == '-' {
				h.stripTabs = true
				i++
			}
			for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
				i++
			}
			var d strings.Builder
			for ; i < len(s) && strings.IndexByte(" \t\n;&|<>()", s[i]) < 0; i++ {
				switch s[i] {
				case '\'', '"', '\\':
					h.quoted = true
				default:
					d.WriteByte(s[i])
				}
			}
			h.delim = d.String()
			i-- // the separator after the delimiter is read as usual
			if h.delim != "" {
				pending = append(pending, h)
			}
		case c == '<' && strings.HasPrefix(s[i:], "<<<"):
			// a here-string: its word is not a redirect target (it is still read as an argument)
			flushWord()
			hereStr = true
			i += 2
		case c == '\\' && i+1 < len(s):
			if s[i+1] != '\n' {
				w.WriteByte(s[i+1])
				inWord = true
			}
			i++
		case c == '\'':
			j := strings.IndexByte(s[i+1:], '\'')
			if j < 0 {
				j = len(s) - i - 1
			}
			w.WriteString(s[i+1 : i+1+j])
			inWord = true
			i += j + 1
		case c == '"':
			j := i + 1
			for j < len(s) && s[j] != '"' {
				if s[j] == '\\' && j+1 < len(s) {
					j++
				}
				j++
			}
			inner := s[i+1 : min(j, len(s))]
			w.WriteString(unescapeDouble(inner))
			inWord = true
			for _, sub := range substitutions(inner) {
				out = append(out, splitDepth(sub, depth+1)...)
			}
			i = j
		case c == '$' && i+1 < len(s) && s[i+1] == '(' || c == '`':
			// A substitution runs its own commands; its output stays part of this word.
			sub := substitutions(s[i:])
			n := 1
			if len(sub) > 0 {
				body := sub[0]
				out = append(out, splitDepth(body, depth+1)...)
				if c == '`' {
					n = len(body) + 2
				} else {
					n = len(body) + 3
				}
			}
			i += n - 1
			inWord = true
		case c == '|' && !strings.HasPrefix(s[i:], "||"):
			flushCmd()
			if strings.HasPrefix(s[i:], "|&") {
				i++
			}
			pipe = len(out) // 1 + index of the command just flushed
		case c == ';' || c == '&' || c == '|' || c == '\n' || c == '(' || c == ')':
			if c == '|' {
				i++ // ||
			}
			flushCmd()
		case c == '<' || c == '>':
			flushWord()
			// 2>&1, >&2, <&-: a descriptor, not a file.
			if i+1 < len(s) && s[i+1] == '&' {
				i++
				for i+1 < len(s) && (s[i+1] >= '0' && s[i+1] <= '9' || s[i+1] == '-') {
					i++
				}
				continue
			}
			readIn = c == '<' && (i+1 >= len(s) || s[i+1] != '>')
			for i+1 < len(s) && (s[i+1] == '>' || s[i+1] == '<' || s[i+1] == '|') {
				i++
			}
			redirect = true
		case c == ' ' || c == '\t' || c == '\r':
			flushWord()
		case c == '#' && !inWord:
			// a comment runs to the end of the line
			for i+1 < len(s) && s[i+1] != '\n' {
				i++
			}
		default:
			w.WriteByte(c)
			inWord = true
		}
	}
	flushCmd()

	// Commands handed to a shell or eval as a string.
	for _, c := range out {
		args := program(c.args)
		if len(args) == 0 {
			continue
		}
		switch name := progName(args[0]); name {
		case "sh", "bash", "zsh", "dash", "ksh", "fish":
			for k := 1; k+1 < len(args); k++ {
				if strings.HasPrefix(args[k], "-") && strings.Contains(args[k], "c") && !strings.HasPrefix(args[k], "--") {
					out = append(out, splitDepth(args[k+1], depth+1)...)
					break
				}
			}
		case "eval":
			out = append(out, splitDepth(strings.Join(args[1:], " "), depth+1)...)
		}
	}
	return out
}

// heredoc is one `<<DELIM` waiting for its body (the lines after the command).
type heredoc struct {
	delim     string
	quoted    bool // <<'EOF' / <<"EOF" / <<\EOF: the body is taken literally
	stripTabs bool // <<-EOF
	owner     int  // index in the command list of the command that reads it
}

// heredocBody returns the body starting at s[start:] and the index just past
// its terminator line (or the end of s).
func heredocBody(s string, start int, h heredoc) (string, int) {
	var body strings.Builder
	for i := start; i < len(s); {
		end := strings.IndexByte(s[i:], '\n')
		next := len(s)
		if end >= 0 {
			next = i + end + 1
		} else {
			end = len(s) - i
		}
		line := s[i : i+end]
		if h.stripTabs {
			line = strings.TrimLeft(line, "\t")
		}
		if strings.TrimRight(line, "\r") == h.delim {
			return body.String(), next
		}
		body.WriteString(line)
		body.WriteByte('\n')
		i = next
	}
	return body.String(), len(s)
}

// commands are what a heredoc body runs: all of it when a shell reads it as
// its script, else only the substitutions of an unquoted body.
func (h heredoc) commands(body string, cmds []simpleCmd, depth int) []simpleCmd {
	if h.owner < len(cmds) {
		if args := program(cmds[h.owner].args); len(args) > 0 {
			switch progName(args[0]) {
			case "sh", "bash", "zsh", "dash", "ksh", "fish", "eval", "source", ".":
				if !slicesHasDashC(args) {
					return splitDepth(body, depth+1)
				}
			}
		}
	}
	if h.quoted {
		return nil
	}
	var out []simpleCmd
	for _, sub := range substitutions(body) {
		out = append(out, splitDepth(sub, depth+1)...)
	}
	return out
}

func slicesHasDashC(args []string) bool {
	for _, a := range args[1:] {
		if strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && strings.Contains(a, "c") {
			return true
		}
	}
	return false
}

// substitutions returns the bodies of $( ) and backtick substitutions in s.
func substitutions(s string) []string {
	var subs []string
	for i := 0; i < len(s); i++ {
		switch {
		case s[i] == '$' && i+1 < len(s) && s[i+1] == '(':
			depth, j := 1, i+2
			for ; j < len(s) && depth > 0; j++ {
				switch s[j] {
				case '(':
					depth++
				case ')':
					depth--
				}
			}
			end := j
			if depth == 0 {
				end = j - 1
			}
			subs = append(subs, s[i+2:end])
			i = j - 1
		case s[i] == '`':
			j := strings.IndexByte(s[i+1:], '`')
			if j < 0 {
				j = len(s) - i - 1
			}
			subs = append(subs, s[i+1:i+1+j])
			i += j + 1
		}
	}
	return subs
}

func unescapeDouble(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) && strings.IndexByte("\"\\$`", s[i+1]) >= 0 {
			i++
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// wrappers run the command that follows them; flagsWithValue are their
// options that take a separate argument.
var wrappers = map[string]map[string]bool{
	"sudo":       {"-u": true, "-g": true, "-C": true, "-h": true, "-p": true, "-U": true},
	"doas":       {"-u": true, "-C": true},
	"env":        {"-u": true, "-C": true, "-S": true},
	"command":    {},
	"builtin":    {},
	"exec":       {"-a": true},
	"nohup":      {},
	"time":       {"-f": true, "-o": true},
	"nice":       {"-n": true},
	"ionice":     {"-c": true, "-n": true},
	"stdbuf":     {"-i": true, "-o": true, "-e": true},
	"caffeinate": {"-t": true, "-w": true},
	"xargs":      {"-I": true, "-n": true, "-P": true, "-L": true, "-d": true, "-s": true, "-E": true, "-a": true},
	"timeout":    {"-s": true, "-k": true},
	"watch":      {"-n": true, "-d": false},
	"arch":       {},
}

// program strips variable assignments and wrappers (sudo, env, xargs, …) from
// the front of a command's words, so args[0] is the program that runs. It
// also returns the wrappers it stripped: they run too, and policy applies to
// them as well. `command -v x` only looks x up, so it runs nothing.
func program(args []string) []string { a, _ := unwrap(args); return a }

func unwrap(args []string) (prog, wrappersRun []string) {
	for len(args) > 0 {
		a := args[0]
		if isAssignment(a) {
			args = args[1:]
			continue
		}
		flags, ok := wrappers[progName(a)]
		if !ok {
			return args, wrappersRun
		}
		name := progName(a)
		wrappersRun = append(wrappersRun, a)
		args = args[1:]
		if name == "command" && len(args) > 0 && (args[0] == "-v" || args[0] == "-V") {
			return nil, wrappersRun
		}
		for len(args) > 0 {
			f := args[0]
			if f == "--" {
				args = args[1:]
				break
			}
			if strings.HasPrefix(f, "-") && len(f) > 1 {
				args = args[1:]
				if flags[f] && len(args) > 0 {
					args = args[1:]
				}
				continue
			}
			if name == "env" && isAssignment(f) {
				args = args[1:]
				continue
			}
			break
		}
		if name == "timeout" && len(args) > 0 {
			args = args[1:] // the duration
		}
	}
	return args, wrappersRun
}

func isAssignment(w string) bool {
	eq := strings.IndexByte(w, '=')
	if eq <= 0 {
		return false
	}
	for i, r := range w[:eq] {
		if !(r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || i > 0 && r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

// progName is a program's comparable name: base name, lower case, no .exe.
func progName(p string) string {
	p = path.Base(strings.ReplaceAll(p, `\`, "/"))
	p = strings.ToLower(p)
	return strings.TrimSuffix(p, ".exe")
}
