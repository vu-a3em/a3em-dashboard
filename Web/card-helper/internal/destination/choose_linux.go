package destination

import (
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
)

// choose uses the desktop's own dialog: the portal's (see portal.go), where the desktop has one,
// else zenity (GNOME and most others) or kdialog (KDE). With none, the image goes to the
// default folder, and the page says so.
func choose(dir, name, prompt string) (string, error) {
	if path, err := choosePortal(dir, name, prompt); !errors.Is(err, errNoPortal) {
		return path, err
	}
	var cmd *exec.Cmd
	switch {
	case have("zenity"):
		cmd = exec.Command("zenity", "--file-selection", "--save", "--confirm-overwrite", "--title="+prompt, "--filename="+filepath.Join(dir, name))
	case have("kdialog"):
		cmd = exec.Command("kdialog", "--title", prompt, "--getsavefilename", filepath.Join(dir, name), "*.img")
	default:
		return "", ErrNoDialog
	}
	out, err := cmd.Output()
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 {
		return "", ErrCanceled
	}
	if err != nil {
		return "", errors.New("the save dialog could not be shown: " + err.Error())
	}
	return strings.TrimSpace(string(out)), nil
}

func have(tool string) bool {
	_, err := exec.LookPath(tool)
	return err == nil
}
