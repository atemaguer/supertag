//go:build unix

package main

import (
	"os/exec"
	"syscall"
)

// detach starts cmd in its own session, without the terminal the TUI holds, so nothing it runs
// can prompt on that terminal or read its keys.
func detach(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
