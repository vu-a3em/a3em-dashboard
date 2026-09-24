package destination

import (
	"bytes"
	"errors"
	"os/exec"
	"strings"
)

func appleScriptString(value string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value) + `"`
}

// choose shows AppleScript's "choose file name", which asks before replacing a file. It opens
// in front, since it is started from the browser's helper rather than from an app.
func choose(dir, name, prompt string) (string, error) {
	cmd := exec.Command("osascript",
		"-e", "tell me to activate",
		"-e", "set chosen to choose file name with prompt "+appleScriptString(prompt)+
			" default name "+appleScriptString(name)+" default location (POSIX file "+appleScriptString(dir)+")",
		"-e", "return POSIX path of chosen")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if strings.Contains(stderr.String(), "-128") {
			return "", ErrCanceled
		}
		return "", errors.New("the save dialog could not be shown: " + strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(out)), nil
}
