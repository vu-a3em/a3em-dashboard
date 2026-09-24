package blockdev

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

/*
	Raw access to a card on macOS, through authopen.

	A card's raw device belongs to root, and macOS's privacy protection guards it on top of
	that: opening it needs the Removable Volumes permission, held by the app responsible for
	the process. The helper's responsible app is the browser that started it, which already has
	that permission — it is how the helper reads the mounted card at all. But a worker started
	as root through osascript is no longer the browser's, and macOS refuses it "Operation not
	permitted", password or no password.

	/usr/libexec/authopen is Apple's answer: a root tool that asks for an administrator password
	itself, checks Removable Volumes against the process that started it — this one, and so the
	browser — opens the device, and hands the open descriptor back over a socket. Everything
	after that runs in this process, as the person, on that descriptor.

	One password per operation, however many cards or opens it involves: `security authorize`
	asks once for the right to open every device the operation touches, and each authopen is
	given that authorization rather than asking again.
*/

// ErrCanceled is returned when the administrator password was not given.
var ErrCanceled = errors.New("administrator access was not given")

var (
	authorizationMu sync.Mutex
	authorization   []byte // the held authorization, externalized; nil when none is held
)

func securityTool() string {
	if path := os.Getenv("A3EM_HELPER_SECURITY"); path != "" {
		return path
	}
	return "/usr/bin/security"
}

func authopenTool() string {
	if path := os.Getenv("A3EM_HELPER_AUTHOPEN"); path != "" {
		return path
	}
	return "/usr/libexec/authopen"
}

// viaAuthopenAlways sends every raw open through authopen, so the path can be tested on a disk
// image this process could open by itself.
func viaAuthopenAlways() bool { return os.Getenv("A3EM_HELPER_AUTHOPEN_ALWAYS") == "1" }

// ForcedAuthopen reports the test switch, for the job runner to authorize even disk images.
func ForcedAuthopen() bool { return viaAuthopenAlways() }

// errNoPrivileged is never returned here: authopen is always there to try.
var errNoPrivileged = errors.New("no privileged open on this platform")

func openRight(path string, write bool) string {
	if write {
		return "sys.openfile.readwrite." + path
	}
	return "sys.openfile.readonly." + path
}

// Authorize asks, with one password prompt, for the right to open every path, and holds it
// until release is called. Paths this process can already open need nothing and are left out;
// when that is all of them, nothing is asked.
func Authorize(paths []string, write bool) (release func(), err error) {
	var rights []string
	for _, path := range paths {
		if viaAuthopenAlways() || !CanAccess(path) {
			rights = append(rights, openRight(path, write))
			if write {
				// Some opens in a writing operation only read.
				rights = append(rights, openRight(path, false))
			}
		}
	}
	if len(rights) == 0 {
		return func() {}, nil
	}
	cmd := exec.Command(securityTool(), append([]string{"authorize", "-u", "-e", "-w"}, rights...)...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("could not ask for administrator access: %w", err)
	}
	stop := func() {
		stdout.Close()
		cmd.Process.Kill()
		cmd.Wait()
	}
	// The authorization comes first, once the prompt has been answered; then a YES or NO line.
	external := make([]byte, 32)
	if _, err := io.ReadFull(stdout, external); err != nil {
		stop()
		return nil, fmt.Errorf("could not ask for administrator access: %w", err)
	}
	status := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(stderr).ReadString('\n')
		status <- strings.TrimSpace(line)
	}()
	var answer string
	select {
	case answer = <-status:
	case <-time.After(10 * time.Second):
	}
	if !strings.HasPrefix(answer, "YES") {
		stop()
		if strings.Contains(answer, "-60006") || strings.Contains(answer, "-60005") || answer == "" {
			return nil, ErrCanceled
		}
		return nil, fmt.Errorf("administrator access was refused: %s", answer)
	}
	authorizationMu.Lock()
	authorization = external
	authorizationMu.Unlock()
	return func() {
		authorizationMu.Lock()
		authorization = nil
		authorizationMu.Unlock()
		stop()
	}, nil
}

// openPrivileged opens path through authopen and returns the descriptor it sends back.
func openPrivileged(path string, flag int) (*os.File, error) {
	pair, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, err
	}
	ours := os.NewFile(uintptr(pair[0]), "authopen")
	theirs := os.NewFile(uintptr(pair[1]), "authopen-stdout")
	defer ours.Close()

	args := []string{"-stdoutpipe"}
	authorizationMu.Lock()
	held := authorization
	authorizationMu.Unlock()
	if held != nil {
		args = append(args, "-extauth")
	}
	if flag&(syscall.O_RDWR|syscall.O_WRONLY) != 0 {
		args = append(args, "-o", strconv.Itoa(flag))
	}
	args = append(args, path)
	cmd := exec.Command(authopenTool(), args...)
	cmd.Stdout = theirs
	if held != nil {
		cmd.Stdin = bytes.NewReader(held)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		theirs.Close()
		return nil, fmt.Errorf("could not start authopen: %w", err)
	}
	theirs.Close()

	// The descriptor arrives as SCM_RIGHTS on a one-byte message, once authopen has opened it.
	var received *os.File
	buf := make([]byte, 64)
	oob := make([]byte, syscall.CmsgSpace(4))
	if _, oobn, _, _, err := syscall.Recvmsg(int(ours.Fd()), buf, oob, 0); err == nil && oobn > 0 {
		if messages, err := syscall.ParseSocketControlMessage(oob[:oobn]); err == nil && len(messages) > 0 {
			if fds, err := syscall.ParseUnixRights(&messages[0]); err == nil && len(fds) > 0 {
				received = os.NewFile(uintptr(fds[0]), path)
			}
		}
	}
	waitErr := cmd.Wait()
	if received != nil {
		return received, nil
	}
	text := strings.TrimSpace(stderr.String())
	switch {
	case strings.Contains(text, "Operation not permitted"):
		return nil, ErrPermission
	case strings.Contains(strings.ToLower(text), "not authorized"), strings.Contains(text, "-60006"), strings.Contains(text, "canceled"):
		return nil, ErrCanceled
	}
	if text == "" && waitErr != nil {
		text = waitErr.Error()
	}
	return nil, fmt.Errorf("authopen could not open %s: %s", path, text)
}

// OpenForChild opens path for a tool this process runs, such as fsck, directly where it can and
// through authopen where it cannot. The tool is handed the descriptor as /dev/fd/3.
func OpenForChild(path string, write bool) (*os.File, error) {
	flag := os.O_RDONLY
	if write {
		flag = os.O_RDWR
	}
	if !viaAuthopenAlways() {
		if file, err := os.OpenFile(path, flag, 0); err == nil {
			return file, nil
		} else if !errors.Is(err, os.ErrPermission) {
			return nil, Classify(err)
		}
	}
	return openPrivileged(path, flag)
}
