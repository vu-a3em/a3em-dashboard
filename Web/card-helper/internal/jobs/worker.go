package jobs

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/blockdev"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/platform"
)

/*
	The elevated worker, on Linux and Windows.

	On macOS there is none: a root worker is refused the card by the privacy protection there,
	so the job runs in this process on descriptors authopen opens (blockdev/authorize_darwin.go),
	after one password prompt for all of them.

	A card's raw device belongs to root (Linux) or needs an elevated token (Windows),
	but the helper Chrome starts runs as the person using it — and must, so that what it
	mounts belongs to them. So raw-device work is written to a job directory, and a second
	copy of this executable is started with administrator rights to do it:

	    osascript "do shell script … with administrator privileges"   (macOS)
	    pkexec                                                          (Linux)
	    Start-Process -Verb RunAs                                       (Windows)

	The worker reports progress by appending JSON lines to a file and leaves its result in
	another, because none of those launchers pass output through while the process runs. A
	batch is one job, so preparing six cards costs one password prompt, not six.

	The worker trusts nothing in the job but the request itself: it lists devices again with
	its own privileges and refuses any whose fingerprint differs from the one confirmed.
*/

const (
	jobFile      = "job.json"
	progressFile = "progress.jsonl"
	resultFile   = "result.json"
	// stopFile, once it exists, asks the worker to stop a job that can stop.
	stopFile = "stop"
)

// Execute runs a job in this process when it can open everything the job touches, and in an
// elevated worker otherwise. reason completes "A3EM Card Helper needs administrator access
// to …" in the system's prompt.
func Execute(job Job, plat platform.Platform, paths []string, report Reporter, reason string) (Result, error) {
	// A3EM_HELPER_WORKER=direct runs the worker as a separate process without elevation, so
	// the job exchange can be tested without an administrator prompt.
	if os.Getenv("A3EM_HELPER_WORKER") == "direct" {
		return elevated(job, plat, report, reason)
	}
	here := true
	for _, path := range paths {
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			continue
		}
		if !blockdev.CanAccess(path) {
			here = false
		}
	}
	if here && !blockdev.ForcedAuthopen() {
		return Run(job, plat, report), nil
	}
	if runtime.GOOS == "darwin" {
		report(Update{Stage: "authorize", Note: "Waiting for an administrator password."})
		release, err := blockdev.Authorize(paths, writes(job))
		if err != nil {
			message, code := describe(err)
			return Result{}, &Failed{message, code, ""}
		}
		defer release()
		return Run(job, plat, report), nil
	}
	return elevated(job, plat, report, reason)
}

// writes is whether a job opens its devices for writing.
func writes(job Job) bool {
	return job.Kind == KindPrepare || job.Kind == KindFix || (job.Kind == KindFsck && job.Repair)
}

var canceled = regexp.MustCompile(`(?i)user cancel+ed|\(-128\)|canceled by the user|cancelled by the user|request dismissed|not authorized|authorization could not be obtained`)

func elevated(job Job, plat platform.Platform, report Reporter, reason string) (Result, error) {
	if runtime.GOOS != "windows" {
		job.Owner = &Owner{UID: os.Getuid(), GID: os.Getgid()}
	}
	dir, err := os.MkdirTemp("", "a3em-job-"+newID()+"-")
	if err != nil {
		return Result{}, err
	}
	defer os.RemoveAll(dir)
	raw, _ := json.Marshal(job)
	if err := os.WriteFile(filepath.Join(dir, jobFile), raw, 0o600); err != nil {
		return Result{}, err
	}
	self, err := os.Executable()
	if err != nil {
		return Result{}, err
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	command, err := plat.Elevate(self, []string{"worker", dir}, reason)
	if os.Getenv("A3EM_HELPER_WORKER") == "direct" {
		command, err = platform.Command{Name: self, Args: []string{"worker", dir}}, nil
	}
	if err != nil {
		return Result{}, err
	}
	cmd := exec.Command(command.Name, command.Args...)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	// The system's password prompt can open behind the browser, so the page says it is coming.
	if os.Getenv("A3EM_HELPER_WORKER") != "direct" {
		report(Update{Stage: "authorize", Note: "Waiting for an administrator password."})
	}
	if err := cmd.Start(); err != nil {
		return Result{}, &platform.CommandError{Message: "Could not ask for administrator access: " + err.Error(), Command: command.Name}
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	// The worker cannot be signaled across the privilege line, so asking it to stop is a file.
	finished := make(chan struct{})
	defer close(finished)
	if job.Stop != nil {
		go func() {
			select {
			case <-job.Stop:
				os.WriteFile(filepath.Join(dir, stopFile), nil, 0o644)
			case <-finished:
			}
		}()
	}

	var offset int64
	forward := func() {
		file, err := os.Open(filepath.Join(dir, progressFile))
		if err != nil {
			return
		}
		defer file.Close()
		file.Seek(offset, 0)
		reader := bufio.NewReader(file)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return // a partial line is read again next time
			}
			offset += int64(len(line))
			var update Update
			if json.Unmarshal(line, &update) == nil {
				report(update)
			}
		}
	}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	var waitErr error
wait:
	for {
		select {
		case waitErr = <-done:
			forward()
			break wait
		case <-ticker.C:
			forward()
		}
	}

	raw, err = os.ReadFile(filepath.Join(dir, resultFile))
	if err != nil {
		text := output.String()
		code := -1
		var exit *exec.ExitError
		if errors.As(waitErr, &exit) {
			code = exit.ExitCode()
		}
		if canceled.MatchString(text) || (runtime.GOOS == "linux" && code == 126) {
			return Result{}, &Failed{"Administrator access was not given, so nothing was changed.", "cancelled", ""}
		}
		return Result{}, &platform.CommandError{Message: "The administrator step did not finish.", Command: command.Name, Code: code, Output: text}
	}
	var result Result
	if err := json.Unmarshal(raw, &result); err != nil {
		return Result{}, err
	}
	return result, nil
}

// RunWorker is the elevated side: it does the job in dir and leaves the result there.
func RunWorker(dir string, plat platform.Platform) error {
	raw, err := os.ReadFile(filepath.Join(dir, jobFile))
	if err != nil {
		return err
	}
	var job Job
	if err := json.Unmarshal(raw, &job); err != nil {
		return err
	}
	// O_EXCL throughout: running as root in a directory another process could reach, nothing
	// is written through a name that already exists, so nothing can be redirected by a link.
	progress, err := os.OpenFile(filepath.Join(dir, progressFile), os.O_WRONLY|os.O_CREATE|os.O_EXCL|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer progress.Close()
	var mu sync.Mutex
	last := time.Time{}
	report := func(update Update) {
		mu.Lock()
		defer mu.Unlock()
		// Progress within a stage is thinned; stage changes always go through.
		if update.Done != 0 && update.Done != update.Total && time.Since(last) < 200*time.Millisecond {
			return
		}
		last = time.Now()
		line, _ := json.Marshal(update)
		progress.Write(append(line, '\n'))
	}
	stop := make(chan struct{})
	go func() {
		for {
			if _, err := os.Stat(filepath.Join(dir, stopFile)); err == nil {
				close(stop)
				return
			}
			time.Sleep(250 * time.Millisecond)
		}
	}()
	job.Stop = stop
	result := Run(job, plat, report)
	out, _ := json.Marshal(result)
	temporary := filepath.Join(dir, resultFile+".tmp")
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := file.Write(out); err != nil {
		file.Close()
		return err
	}
	file.Close()
	if err := os.Rename(temporary, filepath.Join(dir, resultFile)); err != nil {
		return fmt.Errorf("could not leave the result: %w", err)
	}
	return nil
}
