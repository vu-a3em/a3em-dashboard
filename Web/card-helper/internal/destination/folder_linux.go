package destination

import (
	"errors"
	"os/exec"
	"strings"
)

// chooseFolder uses the desktop's own dialog, the same order the save dialog tries: the
// portal where there is one, else zenity or kdialog. With none, the page falls back to
// copying through the browser, which needs no dialog here at all.
func chooseFolder(dir, prompt string) (string, error) {
	if path, err := chooseFolderPortal(dir, prompt); !errors.Is(err, errNoPortal) {
		return path, err
	}
	var cmd *exec.Cmd
	switch {
	case have("zenity"):
		cmd = exec.Command("zenity", "--file-selection", "--directory", "--title="+prompt, "--filename="+dir+"/")
	case have("kdialog"):
		cmd = exec.Command("kdialog", "--title", prompt, "--getexistingdirectory", dir)
	default:
		return "", ErrNoDialog
	}
	out, err := cmd.Output()
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 {
		return "", ErrCanceled
	}
	if err != nil {
		return "", errors.New("the folder dialog could not be shown: " + err.Error())
	}
	return strings.TrimSpace(string(out)), nil
}
