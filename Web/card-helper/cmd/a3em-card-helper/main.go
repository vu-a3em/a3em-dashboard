// Command a3em-card-helper is the A3EM dashboard's native helper for SD cards.
//
// Started by a browser, it is a native messaging host: length-prefixed JSON on stdin and
// stdout, one process per message or port, exiting when the browser closes stdin. Started
// from a terminal it installs or checks itself. Started by itself with administrator rights,
// it is the worker that does raw-device work.
//
//	a3em-card-helper install [--system] [--extension-id ID ...]
//	a3em-card-helper uninstall [--system]
//	a3em-card-helper doctor
//	a3em-card-helper call '{"op":"listDevices"}'   (or call @request.json)
//	a3em-card-helper version
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/dispatch"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/install"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/jobs"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/platform"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/protocol"
)

// version is set at build time with -ldflags "-X main.version=…": by the release workflow from
// the tag, and by tools/helper.mjs from `git describe`. A plain `go build` says it is a dev build.
var version = "0.0.0-dev"

func main() {
	args := os.Args[1:]
	command := ""
	if len(args) > 0 {
		command = args[0]
	}
	var err error
	switch command {
	case "worker":
		if len(args) != 2 {
			err = errors.New("usage: a3em-card-helper worker <job directory>")
			break
		}
		err = jobs.RunWorker(args[1], platform.Current())
	case "install", "uninstall":
		options := install.Options{}
		for i := 1; i < len(args); i++ {
			switch args[i] {
			case "--system":
				options.System = true
			case "--extension-id":
				if i+1 < len(args) {
					options.ExtensionIDs = append(options.ExtensionIDs, args[i+1])
					i++
				}
			case "--executable":
				if i+1 < len(args) {
					options.Executable = args[i+1]
					i++
				}
			default:
				err = fmt.Errorf("unknown option %s", args[i])
			}
		}
		if err != nil {
			break
		}
		if command == "install" {
			fmt.Println("Registering the A3EM card helper:")
			err = install.Install(os.Stdout, options)
		} else {
			err = install.Uninstall(os.Stdout, options.System)
		}
	case "doctor":
		fmt.Println("A3EM card helper", version)
		err = install.Doctor(os.Stdout)
		if err == nil {
			fmt.Println("Everything is in place.")
		}
	case "call":
		if len(args) != 2 {
			err = errors.New(`usage: a3em-card-helper call '{"op":"listDevices"}'`)
			break
		}
		err = call(args[1])
	case "version", "--version":
		fmt.Println(version)
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		// A browser passes the calling extension's origin, and on Windows a parent window handle.
		if command == "" || strings.HasPrefix(command, "chrome-extension://") || strings.HasPrefix(command, "--parent-window") {
			err = host()
		} else {
			fmt.Fprint(os.Stderr, usage)
			os.Exit(2)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "a3em-card-helper:", err)
		os.Exit(1)
	}
}

const usage = `a3em-card-helper — the A3EM dashboard's helper for SD cards.

  install [--system] [--extension-id ID]   register with every Chromium browser found
  uninstall [--system]                     remove those registrations
  doctor                                   check the registrations and that the helper answers
  call '<json request>' | @file.json       answer one request, for testing
  version                                  print the version

Browsers start it with no command; it is not meant to be run that way by hand.
`

// host is the native messaging loop.
func host() error {
	ignoreBrokenPipe()
	var mu sync.Mutex
	send := func(message any) {
		frame, err := protocol.Encode(message)
		if errors.Is(err, protocol.ErrTooLarge) {
			id := ""
			if failure, ok := message.(protocol.Failure); ok {
				id = failure.ID
			} else if m, ok := message.(map[string]any); ok {
				id, _ = m["id"].(string)
			}
			frame, err = protocol.Encode(protocol.Failure{ID: id, Error: err.Error(), Code: "response-too-large"})
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "a3em-card-helper: could not send:", err)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		// A closed stdout means the page has gone; the work still finishes.
		os.Stdout.Write(frame)
	}
	d, err := dispatch.New(platform.Current(), version, send)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "a3em-card-helper %s ready on %s\n", version, platform.Current().ID())
	var work sync.WaitGroup
	for {
		raw, err := protocol.Read(os.Stdin)
		if err != nil {
			// The browser closes stdin when the port closes. Anything still running — a format
			// halfway through, say — is allowed to finish rather than leave a half-written card.
			work.Wait()
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		work.Add(1)
		go func() {
			defer work.Done()
			send(d.Handle(raw))
		}()
	}
}

// call answers one request given on the command line, with progress on stderr.
func call(request string) error {
	// "@path" reads the request from a file, which spares shells whose quoting mangles JSON.
	if path, ok := strings.CutPrefix(request, "@"); ok {
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		request = string(raw)
	}
	var fields map[string]any
	if err := json.Unmarshal([]byte(request), &fields); err != nil {
		return err
	}
	if _, ok := fields["id"]; !ok {
		fields["id"] = "cli"
	}
	raw, _ := json.Marshal(fields)
	d, err := dispatch.New(platform.Current(), version, func(message any) {
		line, _ := json.Marshal(message)
		fmt.Fprintln(os.Stderr, string(line))
	})
	if err != nil {
		return err
	}
	out, _ := json.MarshalIndent(d.Handle(raw), "", "  ")
	fmt.Println(string(out))
	return nil
}
