// Package procscan reads /proc to find agents that were already running when
// effigentd started, and to check whether a tracked agent is still alive.
package procscan

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/effigent/effigent/internal/endpoint/event"
)

// Scan returns every process plus a pid -> ppid map. Args excludes argv[0],
// matching Tetragon's "arguments" field.
func Scan(procfs string) ([]event.Proc, map[uint32]uint32, error) {
	ents, err := os.ReadDir(procfs)
	if err != nil {
		return nil, nil, err
	}
	var procs []event.Proc
	ppid := map[uint32]uint32{}
	for _, e := range ents {
		pid64, err := strconv.ParseUint(e.Name(), 10, 32)
		if err != nil {
			continue
		}
		pid := uint32(pid64)
		dir := filepath.Join(procfs, e.Name())
		stat, err := os.ReadFile(filepath.Join(dir, "stat"))
		if err != nil {
			continue
		}
		// "pid (comm) state ppid ..." — comm may contain spaces/parens.
		if i := bytes.LastIndexByte(stat, ')'); i > 0 {
			if f := strings.Fields(string(stat[i+1:])); len(f) > 1 {
				if p, err := strconv.ParseUint(f[1], 10, 32); err == nil {
					ppid[pid] = uint32(p)
				}
			}
		}
		cmd, _ := os.ReadFile(filepath.Join(dir, "cmdline"))
		argv := strings.Split(strings.TrimRight(string(cmd), "\x00"), "\x00")
		exe, _ := os.Readlink(filepath.Join(dir, "exe"))
		if exe == "" && len(argv) > 0 {
			exe = argv[0]
		}
		if exe == "" {
			continue // kernel thread
		}
		p := event.Proc{PID: pid, Binary: exe}
		if len(argv) > 1 {
			p.Args = strings.Join(argv[1:], " ")
		}
		procs = append(procs, p)
	}
	return procs, ppid, nil
}

func Alive(procfs string) func(uint32) bool {
	return func(pid uint32) bool {
		_, err := os.Stat(filepath.Join(procfs, strconv.FormatUint(uint64(pid), 10)))
		return err == nil
	}
}
