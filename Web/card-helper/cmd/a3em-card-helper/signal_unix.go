//go:build darwin || linux

package main

import (
	"os"
	"os/signal"
	"syscall"
)

// ignoreBrokenPipe keeps a write to a stdout the browser has closed from killing the process
// mid-format: with SIGPIPE caught, the write fails with EPIPE instead.
func ignoreBrokenPipe() { signal.Notify(make(chan os.Signal, 1), syscall.SIGPIPE) }
