package main

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"time"
)

// bootTime is when the machine booted (/proc/stat btime; a container sees
// its host's), zero when unknown.
func bootTime() time.Time {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return time.Time{}
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if v, ok := strings.CutPrefix(sc.Text(), "btime "); ok {
			if secs, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil && secs > 0 {
				return time.Unix(secs, 0)
			}
		}
	}
	return time.Time{}
}
