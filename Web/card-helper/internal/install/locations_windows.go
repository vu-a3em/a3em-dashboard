package install

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// On Windows a browser finds the manifest through a registry key whose default value is the
// manifest's path. Opera and Vivaldi read Chrome's key, which is always written. The file itself sits beside the executable. HKCU needs no administrator
// rights, which is why the installer is per-user.
func locations(system bool) []Location {
	hive := `HKCU`
	if system {
		hive = `HKLM`
	}
	local := os.Getenv("LOCALAPPDATA")
	key := func(browser, path, data string) Location {
		return Location{Browser: browser, Key: hive + `\Software\` + path + `\NativeMessagingHosts\` + HostName,
			Present: data != "" && exists(filepath.Join(local, data))}
	}
	return []Location{
		key("Chrome", `Google\Chrome`, `Google\Chrome`),
		key("Chromium", `Chromium`, `Chromium`),
		key("Edge", `Microsoft\Edge`, `Microsoft\Edge`),
		key("Brave", `BraveSoftware\Brave-Browser`, `BraveSoftware\Brave-Browser`),
		key("Vivaldi", `Vivaldi`, `Vivaldi`),
	}
}

func manifestPath() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(self), HostName+".json"), nil
}

func writeManifest(location Location, raw []byte) (string, error) {
	path, err := manifestPath()
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, append(raw, '\r', '\n'), 0o644); err != nil {
		return "", err
	}
	if out, err := exec.Command("reg", "add", location.Key, "/ve", "/t", "REG_SZ", "/d", path, "/f").CombinedOutput(); err != nil {
		return "", &regError{strings.TrimSpace(string(out))}
	}
	return location.Key, nil
}

func removeManifest(location Location) error {
	return exec.Command("reg", "delete", location.Key, "/f").Run()
}

func readManifest(location Location) (string, []byte, error) {
	out, err := exec.Command("reg", "query", location.Key, "/ve").Output()
	if err != nil {
		return "", nil, err
	}
	// "    (Default)    REG_SZ    C:\path\to\org.a3em.card_helper.json"
	for _, line := range strings.Split(string(out), "\n") {
		if i := strings.Index(line, "REG_SZ"); i >= 0 {
			path := strings.TrimSpace(line[i+len("REG_SZ"):])
			raw, err := os.ReadFile(path)
			return path, raw, err
		}
	}
	return "", nil, os.ErrNotExist
}

type regError struct{ output string }

func (e *regError) Error() string { return "reg add failed: " + e.output }
