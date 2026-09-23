package install

import (
	"os"
	"path/filepath"
)

func locations(system bool) []Location {
	home, _ := os.UserHomeDir()
	support := filepath.Join(home, "Library", "Application Support")
	if system {
		// The system-wide locations each browser documents.
		return []Location{
			{Browser: "Chrome", Dir: "/Library/Google/Chrome/NativeMessagingHosts", Present: exists("/Applications/Google Chrome.app")},
			{Browser: "Chromium", Dir: "/Library/Application Support/Chromium/NativeMessagingHosts", Present: exists("/Applications/Chromium.app")},
			{Browser: "Edge", Dir: "/Library/Microsoft/Edge/NativeMessagingHosts", Present: exists("/Applications/Microsoft Edge.app")},
		}
	}
	user := func(browser, dir string) Location {
		root := filepath.Join(support, dir)
		return Location{Browser: browser, Dir: filepath.Join(root, "NativeMessagingHosts"), Present: exists(root)}
	}
	return []Location{
		user("Chrome", "Google/Chrome"),
		user("Chrome Beta", "Google/Chrome Beta"),
		user("Chromium", "Chromium"),
		user("Edge", "Microsoft Edge"),
		user("Brave", "BraveSoftware/Brave-Browser"),
		user("Vivaldi", "Vivaldi"),
	}
}
