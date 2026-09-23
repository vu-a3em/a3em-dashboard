package platform

import (
	"bytes"
	"os/exec"
	"strings"
)

func nonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func first(values ...int64) int64 {
	for _, v := range values {
		if v > 0 {
			return v
		}
	}
	return 0
}

// runInput runs a tool with input on stdin and returns its stdout.
func runInput(input, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Stdin = strings.NewReader(input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return "", &CommandError{Message: name + " failed: " + strings.TrimSpace(stderr.String()), Command: name, Output: stderr.String()}
	}
	return stdout.String(), nil
}
