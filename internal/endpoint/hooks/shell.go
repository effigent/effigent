package hooks

import (
	"path"
	"strings"
)

// simpleCmd is one command of a shell line: its words with quotes removed,
// and the files it redirects to or from.
type simpleCmd struct {
	args      []string
	redirects []string
}

// splitShell splits a shell command line into its simple commands. It is a
// deliberately small reading of shell syntax: quotes, backslashes, the usual
// separators (; & | && || newlines, subshells), redirections, $( ) and
// backticks, also inside double quotes. Commands passed to `sh -c` / `eval`
// are read too. Anything it can't follow (variables, aliases, functions,
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
	)
	flushWord := func() {
		if !inWord {
			return
		}
		if redirect {
			cur.redirects = append(cur.redirects, w.String())
			redirect = false
		} else {
			cur.args = append(cur.args, w.String())
		}
		w.Reset()
		inWord = false
	}
	flushCmd := func() {
		flushWord()
		redirect = false
		if len(cur.args) > 0 || len(cur.redirects) > 0 {
			out = append(out, cur)
		}
		cur = simpleCmd{}
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
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
		case c == ';' || c == '&' || c == '|' || c == '\n' || c == '(' || c == ')':
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
// the front of a command's words, so args[0] is the program that runs.
func program(args []string) []string {
	for len(args) > 0 {
		a := args[0]
		if isAssignment(a) {
			args = args[1:]
			continue
		}
		flags, ok := wrappers[progName(a)]
		if !ok {
			return args
		}
		name := progName(a)
		args = args[1:]
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
	return args
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
