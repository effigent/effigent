//go:build !windows

package hooks

import (
	"os"
	"os/user"
	"strconv"
	"sync"
	"syscall"
)

var groupCache sync.Map // uid -> []uint32

// userCanRead reports whether the agent's OS user could read a file by its
// mode bits (directories on the way aren't checked). Unknown user: only
// world-readable files.
func userCanRead(st os.FileInfo, in ClaudeInput) bool {
	mode := st.Mode().Perm()
	if !in.UIDKnown {
		return mode&0o004 != 0
	}
	if in.UID == 0 {
		return true
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return mode&0o004 != 0
	}
	if int(sys.Uid) == in.UID {
		return mode&0o400 != 0
	}
	if mode&0o040 != 0 {
		for _, g := range userGroups(in.UID) {
			if g == uint32(sys.Gid) {
				return true
			}
		}
	}
	return mode&0o004 != 0
}

func userGroups(uid int) []uint32 {
	if v, ok := groupCache.Load(uid); ok {
		return v.([]uint32)
	}
	var out []uint32
	if u, err := user.LookupId(strconv.Itoa(uid)); err == nil {
		if ids, err := u.GroupIds(); err == nil {
			for _, id := range ids {
				if n, err := strconv.ParseUint(id, 10, 32); err == nil {
					out = append(out, uint32(n))
				}
			}
		}
	}
	groupCache.Store(uid, out)
	return out
}
