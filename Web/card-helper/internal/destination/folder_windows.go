package destination

import (
	"errors"
	"os/exec"
	"strings"
)

// chooseFolder shows Windows' folder picker. FolderBrowserDialog rather than the newer
// common dialog because it is in the assembly PowerShell already loads for the save dialog,
// and this runs on whatever PowerShell the machine has. A hidden owner window that stays on
// top keeps it from opening behind the browser.
func chooseFolder(dir, prompt string) (string, error) {
	script := strings.Join([]string{
		"Add-Type -AssemblyName System.Windows.Forms",
		"$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }",
		"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
		"$dialog.Description = " + powerShellString(prompt),
		"$dialog.SelectedPath = " + powerShellString(dir),
		"$dialog.ShowNewFolderButton = $true",
		"if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath } else { exit 3 }",
	}, "; ")
	out, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", script).Output()
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 3 {
		return "", ErrCanceled
	}
	if err != nil {
		return "", errors.New("the folder dialog could not be shown: " + err.Error())
	}
	return strings.TrimSpace(string(out)), nil
}
