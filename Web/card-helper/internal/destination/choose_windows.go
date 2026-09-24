package destination

import (
	"errors"
	"os/exec"
	"strings"
)

func powerShellString(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }

// choose shows Windows' own Save As dialog, from PowerShell, which asks before replacing a
// file. A hidden owner window that stays on top keeps it from opening behind the browser.
func choose(dir, name, prompt string) (string, error) {
	script := strings.Join([]string{
		"Add-Type -AssemblyName System.Windows.Forms",
		"$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }",
		"$dialog = New-Object System.Windows.Forms.SaveFileDialog",
		"$dialog.Title = " + powerShellString(prompt),
		"$dialog.InitialDirectory = " + powerShellString(dir),
		"$dialog.FileName = " + powerShellString(name),
		"$dialog.Filter = 'Disk images (*.img)|*.img|All files (*.*)|*.*'",
		"$dialog.OverwritePrompt = $true",
		"if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileName } else { exit 3 }",
	}, "; ")
	out, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", script).Output()
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 3 {
		return "", ErrCanceled
	}
	if err != nil {
		return "", errors.New("the save dialog could not be shown: " + err.Error())
	}
	return strings.TrimSpace(string(out)), nil
}
