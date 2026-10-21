//go:build !unix

package main

// ownedBySelfOrRoot: ownership isn't checked on Windows (the state dir is
// under the user's own temp directory).
func ownedBySelfOrRoot(string) bool { return true }
