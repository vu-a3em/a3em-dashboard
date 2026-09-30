package destination

import (
	"os"
	"strings"
)

// ChooseFolder shows the system's folder dialog, starting in dir.
//
// A copy needs a folder, not a file name, and it needs the helper to ask for it rather than
// the page: a File System Access handle carries no path, so a folder the browser picked is
// one this process cannot write into. That is why the copy's destination dialog looks
// different from every other picker in the app when the helper is doing the work.
//
// A test can name the answer in A3EM_HELPER_COPY_TO_DIR, so no dialog is shown.
func ChooseFolder(dir, prompt string) (string, error) {
	if test := os.Getenv("A3EM_HELPER_COPY_TO_DIR"); test != "" {
		return test, nil
	}
	path, err := chooseFolder(dir, prompt)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(path), nil
}
