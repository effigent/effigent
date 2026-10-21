package main

import (
	"github.com/effigent/effigent/internal/endpoint/engine"
	"github.com/effigent/effigent/internal/endpoint/peer"
)

// resolvePeer identifies a hook socket caller: kernel credentials, its
// container and pod (cgroup, Tetragon's pod info), and the agent the kernel
// sensor tracks above it, if any.
func resolvePeer(eng *engine.Engine, procfs string, pods *peer.Pods) func(pid, uid, gid int) *peer.Info {
	return func(pid, uid, gid int) *peer.Info {
		in := peer.Resolve(procfs, pid, uid, gid, pods)
		roots := map[uint32]string{}
		for _, r := range eng.Agents() {
			if !r.Orphan {
				roots[r.PID] = r.Agent
			}
		}
		if len(roots) > 0 {
			for _, a := range peer.Ancestors(procfs, pid) {
				if name, ok := roots[uint32(a)]; ok {
					in.Agent, in.AgentPID = name, a
					break
				}
			}
		}
		return &in
	}
}
