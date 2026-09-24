// Package sysenv is what this computer lacks that the card helper relies on.
//
// Installing the helper cannot guarantee a whole system: on Linux especially, asking for a
// password, mounting a card without one, and opening exFAT at all each come from a different
// package, and a minimal desktop can be missing any of them. Found out when a card is already
// in the reader, each reads as the helper being broken. So they are looked for up front — by
// `a3em-card-helper doctor`, and in every `hello`, where the dashboard can show them.
package sysenv

// Issue is one thing missing, and what to do about it.
type Issue struct {
	// Severity is "problem" — something will not work — or "note" — something works less well.
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

// Check lists what is missing on this computer. It is quick: it looks, and runs nothing.
func Check() []Issue {
	issues := check()
	if issues == nil {
		return []Issue{}
	}
	return issues
}
