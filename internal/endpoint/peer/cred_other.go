//go:build !linux

package peer

import (
	"errors"
	"net"
	"os"
)

// Cred is Linux only: elsewhere the hook socket's caller is unknown and the
// hook process's own claims are used, as on the TCP API.
func Cred(c net.Conn) (pid, uid, gid int, err error) {
	return 0, 0, 0, errors.New("peer credentials are only read on Linux")
}

// OpenIn opens name; a root other than "" (a container's) is Linux only.
func OpenIn(root, name string) (*os.File, error) {
	if root != "" {
		return nil, errors.New("container file systems are only read on Linux")
	}
	return os.Open(name)
}
