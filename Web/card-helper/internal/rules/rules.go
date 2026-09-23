// Package rules is what a format request must satisfy, enforced here because the helper is
// the security boundary: the page is trusted to choose sensibly, not to be the only check.
//
// A port of validateFormatRequest in the dashboard's schema (card-format.ts), pinned to it by
// rules_test.go against cases generated from the TypeScript.
package rules

import (
	"fmt"
	"regexp"
	"strings"
)

// AllocationUnitChoices mirrors ALLOCATION_UNIT_CHOICES_BYTES in allocation-unit.ts.
var AllocationUnitChoices = []int64{4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288}

// VolumeLabelMaxLen mirrors VOLUME_LABEL_MAX_LEN.
const VolumeLabelMaxLen = 11

var labelPattern = regexp.MustCompile(`^[A-Za-z0-9 _-]+$`)

// ValidateFormat returns every reason the request cannot be carried out, or nothing.
func ValidateFormat(allocationUnitBytes int64, label string) []string {
	var problems []string
	allowed := false
	for _, choice := range AllocationUnitChoices {
		if choice == allocationUnitBytes {
			allowed = true
		}
	}
	if !allowed {
		problems = append(problems, "Allocation unit must be one of 4 kB, 8 kB, 16 kB, 32 kB, 64 kB, 128 kB, 256 kB, or 512 kB.")
	}
	trimmed := strings.TrimSpace(label)
	switch {
	case trimmed == "":
		problems = append(problems, "A volume label is required.")
	case len([]rune(trimmed)) > VolumeLabelMaxLen:
		problems = append(problems, fmt.Sprintf("Volume label must be %d characters or fewer.", VolumeLabelMaxLen))
	case !labelPattern.MatchString(trimmed):
		problems = append(problems, "Volume label may contain only letters, digits, spaces, hyphens, and underscores.")
	}
	return problems
}

// ConfigFileName and ConfigMaxBytes bound what writeConfig may put on a card: exactly the one
// file the device reads, at a size no real configuration approaches.
const (
	ConfigFileName = "_a3em.cfg"
	ConfigMaxBytes = 64 * 1024
)
