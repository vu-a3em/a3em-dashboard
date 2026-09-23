// Package grant is the two-step confirmation every destructive operation requires.
//
// The page asks for a challenge; the helper describes, in its own words, exactly which disk
// the operation would touch; the person confirms that description; the page redeems the
// token. The device is fingerprinted when the token is issued, so a card swapped between
// confirming and acting invalidates it.
//
// Tokens are signed rather than remembered. Chrome starts a new helper process for every
// message and every port, so a challenge issued by one process is redeemed by another; a
// token held in memory — as the TypeScript helper did — could never be redeemed at all. Each
// token carries its own terms, signed with a per-user key kept in the user's configuration
// directory, and a small ledger there makes each one single-use.
package grant

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/platform"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/safety"
)

// TTL is how long a confirmation stays valid.
const TTL = 60 * time.Second

// Operations that need a grant.
var Operations = map[string]bool{"format": true, "repair": true, "prepare": true}

type terms struct {
	Operation   string `json:"op"`
	Device      string `json:"device"`
	Fingerprint string `json:"fp"`
	Expires     int64  `json:"exp"`
	Nonce       string `json:"nonce"`
}

// Store issues and redeems grants, keeping its key and ledger under Dir.
type Store struct {
	Dir string
	Now func() time.Time
}

// DefaultStore keeps its state in the user's configuration directory, or in
// A3EM_HELPER_STATE_DIR for tests.
func DefaultStore() (*Store, error) {
	if dir := os.Getenv("A3EM_HELPER_STATE_DIR"); dir != "" {
		return &Store{Dir: dir, Now: time.Now}, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	return &Store{Dir: filepath.Join(base, "A3EM", "card-helper"), Now: time.Now}, nil
}

// Fingerprint identifies a device well enough to notice a different card in the same slot.
func Fingerprint(d platform.Device) string {
	return fmt.Sprintf("%s:%d:%s", d.ID, d.SizeBytes, d.Bus)
}

// Describe is what the person confirms, in the helper's own words.
func Describe(d platform.Device, operation string) string {
	var names []string
	for _, v := range d.Volumes {
		switch {
		case v.Label != nil:
			names = append(names, *v.Label)
		case v.Filesystem != nil:
			names = append(names, *v.Filesystem)
		default:
			names = append(names, "unnamed volume")
		}
	}
	what := map[string]string{
		"format":  "Erase and reformat",
		"prepare": "Test, erase, and reformat",
		"repair":  "Attempt to repair the filesystem on",
	}[operation]
	contents := ", containing no readable volume"
	if len(names) > 0 {
		contents = ", containing " + strings.Join(names, ", ")
	}
	return fmt.Sprintf("%s %s — %s, %s%s.", what, d.Node, safety.FormatSize(d.SizeBytes), d.Bus, contents)
}

func (s *Store) key() ([]byte, error) {
	path := filepath.Join(s.Dir, "grant.key")
	if key, err := os.ReadFile(path); err == nil && len(key) == 32 {
		return key, nil
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, key, 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

func sign(key []byte, payload string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Issue returns a token and the description the person must confirm.
func (s *Store) Issue(d platform.Device, operation string) (token, description string, expiresAt int64, err error) {
	if !Operations[operation] {
		return "", "", 0, &safety.Refused{Message: "That operation does not take a confirmation.", Code: "bad-grant"}
	}
	key, err := s.key()
	if err != nil {
		return "", "", 0, err
	}
	nonce := make([]byte, 16)
	rand.Read(nonce)
	t := terms{operation, d.ID, Fingerprint(d), s.Now().Add(TTL).UnixMilli(), hex.EncodeToString(nonce)}
	body, _ := json.Marshal(t)
	payload := base64.RawURLEncoding.EncodeToString(body)
	return payload + "." + sign(key, payload), Describe(d, operation), t.Expires, nil
}

var errBad = &safety.Refused{Message: "That confirmation is not valid. Ask again and confirm.", Code: "bad-grant"}

// Redeem checks a token against the operation and the device as it is now, once.
func (s *Store) Redeem(token, operation string, d platform.Device) error {
	payload, signature, ok := strings.Cut(token, ".")
	if !ok {
		return errBad
	}
	key, err := s.key()
	if err != nil {
		return err
	}
	if !hmac.Equal([]byte(signature), []byte(sign(key, payload))) {
		return errBad
	}
	body, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return errBad
	}
	var t terms
	if json.Unmarshal(body, &t) != nil {
		return errBad
	}
	now := s.Now().UnixMilli()
	if t.Expires <= now {
		return &safety.Refused{Message: "That confirmation has expired. Ask again and confirm.", Code: "bad-grant"}
	}
	if t.Operation != operation {
		return &safety.Refused{Message: "That confirmation was for a different operation.", Code: "bad-grant"}
	}
	if t.Device != d.ID || t.Fingerprint != Fingerprint(d) {
		return &safety.Refused{Message: "The card changed since you confirmed. Check which card is connected and try again.", Code: "bad-grant"}
	}
	return s.spend(t.Nonce, t.Expires, now)
}

// spend records a nonce as used, refusing one already spent.
func (s *Store) spend(nonce string, expires, now int64) error {
	path := filepath.Join(s.Dir, "spent.json")
	ledger := map[string]int64{}
	if raw, err := os.ReadFile(path); err == nil {
		json.Unmarshal(raw, &ledger)
	}
	for n, exp := range ledger {
		if exp <= now {
			delete(ledger, n)
		}
	}
	if _, used := ledger[nonce]; used {
		return &safety.Refused{Message: "That confirmation has already been used. Ask again and confirm.", Code: "bad-grant"}
	}
	ledger[nonce] = expires
	raw, _ := json.Marshal(ledger)
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		return errors.Join(err, os.Remove(temporary))
	}
	return nil
}
