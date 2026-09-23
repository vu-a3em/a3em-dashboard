package install

import (
	"os"
	"path/filepath"
)

func locations(system bool) []Location {
	if system {
		return []Location{
			{Browser: "Chrome", Dir: "/etc/opt/chrome/native-messaging-hosts", Present: exists("/opt/google/chrome")},
			{Browser: "Chromium", Dir: "/etc/chromium/native-messaging-hosts", Present: exists("/usr/lib/chromium") || exists("/usr/lib/chromium-browser") || exists("/snap/chromium")},
			{Browser: "Edge", Dir: "/etc/opt/edge/native-messaging-hosts", Present: exists("/opt/microsoft/msedge")},
		}
	}
	home, _ := os.UserHomeDir()
	config := os.Getenv("XDG_CONFIG_HOME")
	if config == "" {
		config = filepath.Join(home, ".config")
	}
	user := func(browser, dir string) Location {
		root := filepath.Join(config, dir)
		return Location{Browser: browser, Dir: filepath.Join(root, "NativeMessagingHosts"), Present: exists(root)}
	}
	return []Location{
		user("Chrome", "google-chrome"),
		user("Chromium", "chromium"),
		user("Edge", "microsoft-edge"),
		user("Brave", "BraveSoftware/Brave-Browser"),
		user("Vivaldi", "vivaldi"),
	}
}
