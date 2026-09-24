package sysenv

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/destination"
)

func have(tool string) bool {
	_, err := exec.LookPath(tool)
	return err == nil
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func check() []Issue {
	var issues []Issue
	if !have("pkexec") {
		issues = append(issues, Issue{"problem", "pkexec is not installed, so the card helper cannot ask for your password to check a card's layout, prepare cards, or copy them. Install the polkit package that provides pkexec (pkexec or policykit-1)."})
	} else if !agentRunning() {
		issues = append(issues, Issue{"note", "No password prompt (a polkit authentication agent) seems to be running. If the card helper never asks for your password, start one — polkit-gnome, polkit-kde-agent or lxpolkit — or log in to a full desktop."})
	}
	if !have("udisksctl") {
		issues = append(issues, Issue{"problem", "udisks2 is not installed, so the card helper cannot open or eject a card without an administrator password. Install the udisks2 package."})
	}
	if !exfatDriver() {
		issues = append(issues, Issue{"problem", "This system's kernel has no exFAT driver, so it cannot open the recorder's cards at all. Use Linux 5.7 or later, or install exfat-fuse."})
	}
	if !have("fsck.exfat") {
		issues = append(issues, Issue{"note", "exfatprogs is not installed. The card helper finds and repairs the usual damage itself; damage it cannot repair needs exfatprogs' fsck.exfat."})
	}
	if !have("zenity") && !have("kdialog") && !destination.HasPortal() {
		issues = append(issues, Issue{"note", "This desktop has no save dialog the card helper can show — no desktop portal, zenity or kdialog — so a card's image is saved in Documents/A3EM card images rather than wherever you choose. Install xdg-desktop-portal with your desktop's backend, or zenity."})
	}
	if sandboxedOnly() {
		issues = append(issues, Issue{"problem", "The only Chromium browser here is a Snap or Flatpak, whose sandbox may not let it start the card helper. Install Google Chrome, Chromium or Edge from its own package."})
	}
	return issues
}

// exfatDriver is whether the kernel has exFAT built in, loaded, or available to load.
func exfatDriver() bool {
	if data, err := os.ReadFile("/proc/filesystems"); err == nil && strings.Contains(string(data), "exfat") {
		return true
	}
	release, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return true // cannot tell; do not warn
	}
	matches, _ := filepath.Glob(filepath.Join("/lib/modules", strings.TrimSpace(string(release)), "kernel/fs/exfat/exfat.ko*"))
	return len(matches) > 0 || have("mount.exfat-fuse") || have("mount.exfat")
}

// agentRunning looks for a polkit authentication agent among the running processes. GNOME
// Shell and KDE's session carry one of their own.
func agentRunning() bool {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return true // cannot tell; do not warn
	}
	for _, entry := range entries {
		name, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "comm"))
		if err != nil {
			continue
		}
		comm := strings.ToLower(strings.TrimSpace(string(name)))
		if strings.Contains(comm, "polkit") || strings.Contains(comm, "policykit") || comm == "gnome-shell" ||
			comm == "plasmashell" || comm == "kded5" || comm == "kded6" || comm == "lxpolkit" || comm == "xfce-polkit" {
			return true
		}
	}
	return false
}

// sandboxedOnly is a computer whose only Chromium browser is a Snap or Flatpak.
func sandboxedOnly() bool {
	native := exists("/opt/google/chrome") || exists("/opt/microsoft/msedge") || exists("/usr/lib/chromium") ||
		exists("/usr/lib/chromium-browser/chromium-browser") || exists("/opt/brave.com") || exists("/opt/vivaldi")
	home, _ := os.UserHomeDir()
	sandboxed := exists("/snap/chromium") ||
		exists("/var/lib/flatpak/app/com.google.Chrome") || exists("/var/lib/flatpak/app/org.chromium.Chromium") ||
		exists(filepath.Join(home, ".local/share/flatpak/app/com.google.Chrome")) ||
		exists(filepath.Join(home, ".local/share/flatpak/app/org.chromium.Chromium"))
	return sandboxed && !native
}
