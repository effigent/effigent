//go:build linux

package peer

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// Cred returns the pid, uid and gid of the process that connected c (a unix
// socket), as the kernel recorded them at connect time.
func Cred(c net.Conn) (pid, uid, gid int, err error) {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return 0, 0, 0, errors.New("not a unix socket")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return 0, 0, 0, err
	}
	var cred *unix.Ucred
	var serr error
	if err := raw.Control(func(fd uintptr) {
		cred, serr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return 0, 0, 0, err
	}
	if serr != nil {
		return 0, 0, 0, serr
	}
	return int(cred.Pid), int(cred.Uid), int(cred.Gid), nil
}

// OpenIn opens name inside root as if root were "/": absolute symlinks and
// ".." stay inside it (openat2 RESOLVE_IN_ROOT, Linux ≥ 5.6), so a container
// can't point effigentd at the host's files. root "" opens name as is.
func OpenIn(root, name string) (*os.File, error) {
	if root == "" {
		return os.Open(name)
	}
	dir, err := unix.Open(root, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(dir)
	rel := strings.TrimPrefix(filepath.Clean("/"+name), "/")
	if rel == "" {
		rel = "."
	}
	fd, err := unix.Openat2(dir, rel, &unix.OpenHow{
		Flags:   unix.O_RDONLY | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_IN_ROOT | unix.RESOLVE_NO_MAGICLINKS,
	})
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), filepath.Join(root, rel)), nil
}
