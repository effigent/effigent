//go:build unix

package main

import (
	"os"
	"syscall"
)

// ownedBySelfOrRoot: dir doesn't exist yet, or belongs to this user or root.
func ownedBySelfOrRoot(dir string) bool {
	fi, err := os.Lstat(dir)
	if err != nil {
		return os.IsNotExist(err)
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || !fi.IsDir() {
		return false
	}
	return int(st.Uid) == os.Geteuid() || st.Uid == 0
}
