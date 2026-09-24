package platform

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// VirtualAllowed is whether disk images count as cards, for testing (A3EM_HELPER_ALLOW_VIRTUAL,
// or A3EM_HELPER_VIRTUAL_ONLY, which also hides every real device). Read here so a platform can
// skip describing what could never be offered; package safety applies the rule itself.
func VirtualAllowed() bool {
	return os.Getenv("A3EM_HELPER_ALLOW_VIRTUAL") == "1" || os.Getenv("A3EM_HELPER_VIRTUAL_ONLY") == "1"
}

// Output is what a tool printed and how it exited.
type Output struct {
	Stdout, Stderr string
	Code           int
}

// Run runs a tool and fails unless it exits with one of ok (0 when none are given).
// RunAnyExit runs a command whose exit status is its answer rather than a sign of failure:
// fsck_exfat's varies with the damage it finds and with the release of macOS, so no fixed list
// of "successful" codes holds. Only failing to start, or running out of time, is an error.
// files are handed to the command as descriptors 3 onward.
func RunAnyExit(timeout time.Duration, files []*os.File, name string, args []string) (Output, error) {
	codes := make([]int, 256)
	for i := range codes {
		codes[i] = i
	}
	return run(timeout, files, name, args, codes)
}

func Run(timeout time.Duration, name string, args []string, ok ...int) (Output, error) {
	return run(timeout, nil, name, args, ok)
}

func run(timeout time.Duration, files []*os.File, name string, args []string, ok []int) (Output, error) {
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.ExtraFiles = files
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	out := Output{Stdout: stdout.String(), Stderr: stderr.String()}
	var exit *exec.ExitError
	switch {
	case errors.As(err, &exit):
		out.Code = exit.ExitCode()
	case err != nil:
		return out, &CommandError{Message: fmt.Sprintf("Could not run %s: %v", name, err), Command: name, Code: -1}
	}
	if ctx.Err() != nil {
		return out, &CommandError{Message: fmt.Sprintf("%s did not finish within %s.", name, timeout), Command: name, Code: -1, Output: out.Stdout + out.Stderr}
	}
	if len(ok) == 0 {
		ok = []int{0}
	}
	for _, code := range ok {
		if out.Code == code {
			return out, nil
		}
	}
	text := strings.TrimSpace(out.Stderr + "\n" + out.Stdout)
	first := text
	if i := strings.IndexByte(first, '\n'); i >= 0 {
		first = first[:i]
	}
	return out, &CommandError{Message: fmt.Sprintf("%s failed: %s", name, first), Command: name + " " + strings.Join(args, " "), Code: out.Code, Output: text}
}

// Wait retries fn until it succeeds or the time runs out, returning its last error.
func Wait(limit time.Duration, fn func() error) error {
	deadline := time.Now().Add(limit)
	for {
		err := fn()
		if err == nil || time.Now().After(deadline) {
			return err
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// ShellQuote quotes for a POSIX shell.
func ShellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// sdManufacturers are the manufacturer IDs of an SD card's CID register that are widely
// documented. Anything else is shown as the number.
var sdManufacturers = map[int]string{
	0x01: "Panasonic", 0x02: "Toshiba / Kioxia", 0x03: "SanDisk", 0x1b: "Samsung",
	0x1d: "ADATA", 0x27: "Phison", 0x28: "Lexar", 0x31: "Silicon Power", 0x41: "Kingston",
	0x74: "Transcend", 0x76: "Patriot", 0x82: "Sony",
}

// ManufacturerName names an SD manufacturer ID.
func ManufacturerName(id int) string {
	if name, ok := sdManufacturers[id]; ok {
		return fmt.Sprintf("%s (0x%02X)", name, id)
	}
	return fmt.Sprintf("manufacturer 0x%02X", id)
}
