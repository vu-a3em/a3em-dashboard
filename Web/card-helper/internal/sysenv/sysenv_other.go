//go:build !linux

package sysenv

// check has nothing to look for on macOS and Windows: what the helper uses there — authopen,
// security, diskutil, PowerShell — is part of the system.
func check() []Issue { return nil }
