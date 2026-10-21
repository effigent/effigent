// Package tetragon is the Linux sensor + enforcer: it streams Tetragon events
// over gRPC and loads/unloads effigentd's per-agent TracingPolicies.
package tetragon

import (
	"context"
	"net"
	"strconv"
	"strings"
	"time"

	tg "github.com/cilium/tetragon/api/v1/tetragon"
	"github.com/effigent/effigent/internal/endpoint/event"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

type Client struct {
	conn *grpc.ClientConn
	api  tg.FineGuidanceSensorsClient
}

func Dial(addr string) (*Client, error) {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	return &Client{conn: conn, api: tg.NewFineGuidanceSensorsClient(conn)}, nil
}

func (c *Client) Close() error { return c.conn.Close() }

func (c *Client) Add(ctx context.Context, yaml []byte) error {
	_, err := c.api.AddTracingPolicy(ctx, &tg.AddTracingPolicyRequest{Yaml: string(yaml)})
	return err
}

func (c *Client) Delete(ctx context.Context, name string) error {
	_, err := c.api.DeleteTracingPolicy(ctx, &tg.DeleteTracingPolicyRequest{Name: name})
	return err
}

// OwnedPolicies lists TracingPolicies created by effigentd.
func (c *Client) Owned(ctx context.Context) ([]string, error) {
	res, err := c.api.ListTracingPolicies(ctx, &tg.ListTracingPoliciesRequest{})
	if err != nil {
		return nil, err
	}
	var out []string
	for _, p := range res.GetPolicies() {
		if strings.HasPrefix(p.GetName(), PolicyPrefix) {
			out = append(out, p.GetName())
		}
	}
	return out, nil
}

// Events streams translated events until ctx is done or the stream breaks.
// onConnect runs once the stream is established (used to reconcile policies).
func (c *Client) Events(ctx context.Context, out chan<- event.Raw, onConnect func()) error {
	stream, err := c.api.GetEvents(ctx, &tg.GetEventsRequest{})
	if err != nil {
		return err
	}
	if onConnect != nil {
		onConnect()
	}
	for {
		res, err := stream.Recv()
		if err != nil {
			return err
		}
		if r, ok := translate(res); ok {
			select {
			case out <- r:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
}

// Run keeps the event stream alive across Tetragon restarts.
func (c *Client) Run(ctx context.Context, out chan<- event.Raw, onConnect func(), logf func(string, ...any)) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := c.Events(ctx, out, onConnect)
		if ctx.Err() != nil {
			return
		}
		logf("tetragon stream: %v (retrying in %s)", err, backoff)
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func proc(p *tg.Process) event.Proc {
	if p == nil {
		return event.Proc{}
	}
	return event.Proc{
		PID:    p.GetPid().GetValue(),
		ExecID: p.GetExecId(),
		Binary: p.GetBinary(),
		Args:   p.GetArguments(),
		CWD:    p.GetCwd(),
		UID:    p.GetUid().GetValue(),
	}
}

// pod is a process's Kubernetes pod (empty outside Kubernetes).
func pod(p *tg.Pod) event.PodRef {
	if p == nil {
		return event.PodRef{}
	}
	return event.PodRef{Namespace: p.GetNamespace(), Name: p.GetName(), UID: p.GetUid(),
		Container: p.GetContainer().GetName(), ContainerID: p.GetContainer().GetId()}
}

func procs(ps []*tg.Process) []event.Proc {
	out := make([]event.Proc, 0, len(ps))
	for _, p := range ps {
		out = append(out, proc(p))
	}
	return out
}

func translate(res *tg.GetEventsResponse) (event.Raw, bool) {
	r := event.Raw{Time: res.GetTime().AsTime(), Node: res.GetNodeName()}
	switch {
	case res.GetProcessExec() != nil:
		e := res.GetProcessExec()
		r.Kind, r.Process, r.Parent, r.Ancestors = event.Exec, proc(e.GetProcess()), proc(e.GetParent()), procs(e.GetAncestors())
		r.Pod = pod(e.GetProcess().GetPod())
		r.Container = e.GetProcess().GetDocker()
	case res.GetProcessExit() != nil:
		e := res.GetProcessExit()
		r.Kind, r.Process, r.Parent, r.Ancestors = event.Exit, proc(e.GetProcess()), proc(e.GetParent()), procs(e.GetAncestors())
		r.Container = e.GetProcess().GetDocker()
	case res.GetProcessLsm() != nil:
		e := res.GetProcessLsm()
		if !strings.HasPrefix(e.GetPolicyName(), PolicyPrefix) {
			return r, false
		}
		r.Process, r.Ancestors, r.Policy = proc(e.GetProcess()), procs(e.GetAncestors()), e.GetPolicyName()
		r.Container = e.GetProcess().GetDocker()
		blocked := e.GetAction() == tg.KprobeAction_KPROBE_ACTION_OVERRIDE
		switch e.GetFunctionName() {
		case "bprm_check_security":
			r.Kind = event.WouldBlock
			if blocked {
				r.Kind = event.Blocked
			}
			if len(e.GetArgs()) > 0 {
				r.Target = "exec " + e.GetArgs()[0].GetLinuxBinprmArg().GetPath()
			}
		case "socket_connect":
			r.Kind = event.WouldBlock
			if blocked {
				r.Kind = event.Blocked
			}
			if len(e.GetArgs()) > 0 {
				if sa := e.GetArgs()[0].GetSockaddrArg(); sa != nil {
					r.Target = "connect " + net.JoinHostPort(sa.GetAddr(), strconv.Itoa(int(sa.GetPort())))
				}
			}
		case "file_open":
			r.Kind = event.FileOpen
			if blocked {
				r.Kind = event.Blocked
			}
			if len(e.GetArgs()) > 0 {
				r.Target = fileTarget(e.GetArgs()[0].GetFileArg())
			}
		// Self-protection (FR Q20): an agent tree tried to tamper with
		// effigentd/Tetragon. These hooks are always Override, so a match is
		// always a block; surface it so the console shows the attempt.
		case "file_permission":
			r.Kind = event.Blocked
			if len(e.GetArgs()) > 0 {
				r.Target = "self-protect write " + fileTarget(e.GetArgs()[0].GetFileArg())
			}
		case "inode_setattr":
			r.Kind = event.Blocked
			if len(e.GetArgs()) > 0 {
				r.Target = "self-protect truncate " + e.GetArgs()[0].GetPathArg().GetPath()
			}
		case "inode_unlink":
			r.Kind = event.Blocked
			if len(e.GetArgs()) > 0 {
				r.Target = "self-protect delete " + e.GetArgs()[0].GetPathArg().GetPath()
			}
		case "inode_rename":
			r.Kind = event.Blocked
			if a := e.GetArgs(); len(a) >= 2 {
				r.Target = "self-protect rename " + a[0].GetPathArg().GetPath() + " -> " + a[1].GetPathArg().GetPath()
			} else if len(a) == 1 {
				r.Target = "self-protect rename " + a[0].GetPathArg().GetPath()
			}
		case "task_kill":
			r.Kind = event.Blocked
			r.Target = "self-protect signal to effigentd/tetragon"
		default:
			return r, false
		}
	case res.GetProcessKprobe() != nil:
		e := res.GetProcessKprobe()
		if !strings.HasPrefix(e.GetPolicyName(), PolicyPrefix) || e.GetFunctionName() != "tcp_connect" {
			return r, false
		}
		r.Kind, r.Process, r.Parent, r.Ancestors, r.Policy = event.Connect, proc(e.GetProcess()), proc(e.GetParent()), procs(e.GetAncestors()), e.GetPolicyName()
		r.Container = e.GetProcess().GetDocker()
		if len(e.GetArgs()) > 0 {
			s := e.GetArgs()[0].GetSockArg()
			r.Target = net.JoinHostPort(s.GetDaddr(), strconv.Itoa(int(s.GetDport())))
		}
	default:
		return r, false
	}
	return r, true
}

func fileTarget(f *tg.KprobeFile) string {
	return f.GetPath()
}
