//go:build !unix

package main

import "os/exec"

// detach leaves cmd as it is where processes have no Unix sessions.
func detach(*exec.Cmd) {}
