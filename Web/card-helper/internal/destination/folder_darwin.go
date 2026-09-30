package destination

import (
	"bytes"
	"errors"
	"os/exec"
	"strings"
)

// chooseFolder shows AppleScript's "choose folder". It opens in front, since it is started
// from the browser's helper rather than from an app.
func chooseFolder(dir, prompt string) (string, error) {
	cmd := exec.Command("osascript",
		"-e", "tell me to activate",
		"-e", "set chosen to choose folder with prompt "+appleScriptString(prompt)+
			" default location (POSIX file "+appleScriptString(dir)+")",
		"-e", "return POSIX path of chosen")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if strings.Contains(stderr.String(), "-128") {
			return "", ErrCanceled
		}
		return "", errors.New("the folder dialog could not be shown: " + strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(out)), nil
}
