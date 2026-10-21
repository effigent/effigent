package gateway

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"os/user"
	"strconv"
	"strings"
	"sync"
)

var peerNames sync.Map // uid -> user name

// PeerUser names the OS user that owns the client end of a loopback
// connection: the socket whose local address is the client's, from
// /proc/net/tcp(6). The gateway runs as root and sees every user's sockets.
func PeerUser(remoteAddr string) string {
	host, port, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return ""
	}
	ip := net.ParseIP(host)
	p, err := strconv.Atoi(port)
	if ip == nil || err != nil {
		return ""
	}
	file, want := "/proc/net/tcp", procAddr4(ip, p)
	if ip.To4() == nil {
		file, want = "/proc/net/tcp6", procAddr6(ip, p)
	}
	uid := procUID(file, want)
	if uid == "" && ip.To4() != nil { // an IPv4 client on a dual-stack socket
		uid = procUID("/proc/net/tcp6", procAddr6(ip.To16(), p))
	}
	if uid == "" {
		return ""
	}
	if n, ok := peerNames.Load(uid); ok {
		return n.(string)
	}
	name := uid
	if u, err := user.LookupId(uid); err == nil {
		name = u.Username
	}
	peerNames.Store(uid, name)
	return name
}

func procUID(file, local string) string {
	f, err := os.Open(file)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fs := strings.Fields(sc.Text())
		// sl local_address rem_address st tx:rx tr:when retrnsmt uid …
		if len(fs) > 7 && strings.EqualFold(fs[1], local) {
			return fs[7]
		}
	}
	return ""
}

// procAddr4 is how /proc/net/tcp writes an IPv4 address: the 32-bit word in
// host (little-endian) order, then the port.
func procAddr4(ip net.IP, port int) string {
	v := ip.To4()
	return fmt.Sprintf("%02X%02X%02X%02X:%04X", v[3], v[2], v[1], v[0], port)
}

// procAddr6: four 32-bit words, each in host order.
func procAddr6(ip net.IP, port int) string {
	v := ip.To16()
	var b strings.Builder
	for w := 0; w < 4; w++ {
		fmt.Fprintf(&b, "%02X%02X%02X%02X", v[w*4+3], v[w*4+2], v[w*4+1], v[w*4])
	}
	fmt.Fprintf(&b, ":%04X", port)
	return b.String()
}
