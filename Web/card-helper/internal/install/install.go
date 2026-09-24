// Package install registers the helper with each Chromium browser, and checks that it worked.
//
// Chrome finds a native messaging host through a manifest: a small JSON file naming the
// executable and the extensions allowed to start it. Where that manifest must live differs by
// browser and by operating system — a directory on macOS and Linux, a registry key pointing
// at the file on Windows — and a registration that silently did not take is otherwise only
// discovered with a card in hand. So doctor checks every location and then actually starts
// the helper the way a browser would and asks it to identify itself.
package install

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/protocol"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/sysenv"
)

// HostName is the name the extension connects to.
const HostName = "org.a3em.card_helper"

// ExtensionID is the published extension's fixed ID, pinned by the key in its manifest.
const ExtensionID = "fccaomdnpebkiakcflkdgidnnodpalik"

// Manifest is a native messaging host manifest.
type Manifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins"`
}

// Location is one browser's manifest location.
type Location struct {
	Browser string
	// Dir is where the manifest file goes (macOS, Linux), or on Windows the directory the
	// registry key points into.
	Dir string
	// Key is the Windows registry key naming the manifest.
	Key string
	// Present is whether the browser appears to be installed for this user.
	Present bool
}

// Options for install.
type Options struct {
	System       bool
	ExtensionIDs []string
	Executable   string
}

func manifestFor(options Options) Manifest {
	ids := options.ExtensionIDs
	if len(ids) == 0 {
		ids = []string{ExtensionID}
	}
	origins := make([]string, len(ids))
	for i, id := range ids {
		origins[i] = "chrome-extension://" + id + "/"
	}
	return Manifest{Name: HostName, Description: "A3EM card helper: prepares and checks SD cards for A3EM recorders.",
		Path: options.Executable, Type: "stdio", AllowedOrigins: origins}
}

func executable(options Options) (string, error) {
	if options.Executable != "" {
		return filepath.Abs(options.Executable)
	}
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(self)
}

// Install writes the manifest for every browser that is present, and for Chrome regardless.
func Install(out io.Writer, options Options) error {
	exe, err := executable(options)
	if err != nil {
		return err
	}
	options.Executable = exe
	raw, _ := json.MarshalIndent(manifestFor(options), "", "  ")
	wrote := 0
	for _, location := range locations(options.System) {
		if !location.Present && location.Browser != "Chrome" {
			continue
		}
		path, err := writeManifest(location, raw)
		if err != nil {
			fmt.Fprintf(out, "  %-10s could not register: %v\n", location.Browser, err)
			continue
		}
		fmt.Fprintf(out, "  %-10s %s\n", location.Browser, path)
		wrote++
	}
	if wrote == 0 {
		return errors.New("the helper was not registered with any browser")
	}
	return nil
}

// Uninstall removes every manifest this helper wrote.
func Uninstall(out io.Writer, system bool) error {
	for _, location := range locations(system) {
		if removeManifest(location) == nil {
			fmt.Fprintf(out, "  %-10s removed\n", location.Browser)
		}
	}
	return nil
}

// Doctor reports every registration and whether the helper answers.
func Doctor(out io.Writer) error {
	healthy := 0
	var paths []string
	for _, system := range []bool{false, true} {
		for _, location := range locations(system) {
			scope := "user"
			if system {
				scope = "system"
			}
			path, raw, err := readManifest(location)
			if err != nil {
				if location.Present {
					fmt.Fprintf(out, "  %-10s (%s) not registered\n", location.Browser, scope)
				}
				continue
			}
			var manifest Manifest
			if err := json.Unmarshal(raw, &manifest); err != nil {
				fmt.Fprintf(out, "  %-10s (%s) %s is not valid JSON: %v\n", location.Browser, scope, path, err)
				continue
			}
			problems := check(manifest)
			if len(problems) > 0 {
				fmt.Fprintf(out, "  %-10s (%s) %s: %s\n", location.Browser, scope, path, strings.Join(problems, "; "))
				continue
			}
			fmt.Fprintf(out, "  %-10s (%s) registered: %s\n", location.Browser, scope, manifest.Path)
			paths = append(paths, manifest.Path)
			healthy++
		}
	}
	if healthy == 0 {
		return errors.New("the helper is not registered with any browser; run the installer, or `a3em-card-helper install`")
	}
	tested := map[string]bool{}
	for _, path := range paths {
		if tested[path] {
			continue
		}
		tested[path] = true
		reply, err := hello(path)
		if err != nil {
			fmt.Fprintf(out, "  %s did not answer: %v\n", path, err)
			return err
		}
		fmt.Fprintf(out, "  %s answers: version %v on %v\n", path, reply["version"], reply["platform"])
	}
	// What this computer lacks that the helper relies on: the same list the dashboard shows.
	issues := sysenv.Check()
	if len(issues) == 0 {
		fmt.Fprintln(out, "  This computer has everything the card helper uses.")
	}
	problems := 0
	for _, issue := range issues {
		mark := "note"
		if issue.Severity == "problem" {
			mark = "PROBLEM"
			problems++
		}
		fmt.Fprintf(out, "  %s: %s\n", mark, issue.Message)
	}
	if problems > 0 {
		return fmt.Errorf("%d problem(s) above will stop some card tools from working", problems)
	}
	return nil
}

func check(manifest Manifest) []string {
	var problems []string
	if manifest.Name != HostName {
		problems = append(problems, "names "+manifest.Name)
	}
	if manifest.Type != "stdio" {
		problems = append(problems, `type is not "stdio"`)
	}
	if !filepath.IsAbs(manifest.Path) {
		problems = append(problems, "path is not absolute")
	} else if info, err := os.Stat(manifest.Path); err != nil || info.IsDir() {
		problems = append(problems, manifest.Path+" does not exist")
	}
	allowed := false
	for _, origin := range manifest.AllowedOrigins {
		if origin == "chrome-extension://"+ExtensionID+"/" {
			allowed = true
		}
	}
	if !allowed {
		problems = append(problems, "does not allow the A3EM extension")
	}
	return problems
}

// hello starts the helper as a browser would and asks it to identify itself.
func hello(path string) (map[string]any, error) {
	cmd := exec.Command(path, "chrome-extension://"+ExtensionID+"/")
	frame, _ := protocol.Encode(map[string]string{"id": "doctor", "op": "hello"})
	cmd.Stdin = bytes.NewReader(frame)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		cmd.Process.Kill()
		return nil, errors.New("no reply within 10 seconds")
	}
	raw, err := protocol.Read(&stdout)
	if err != nil {
		return nil, fmt.Errorf("no framed reply: %w", err)
	}
	var reply map[string]any
	if err := json.Unmarshal(raw, &reply); err != nil {
		return nil, err
	}
	if reply["ok"] != true {
		return nil, fmt.Errorf("replied %s", raw)
	}
	return reply, nil
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
