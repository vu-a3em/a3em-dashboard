// Package ledger remembers what the helper learned about each card it prepared.
//
// The capacity probe and the write test are destructive, so they can only run while a card is
// being prepared. A later readiness check still wants their answers, so they are kept here,
// on this computer, keyed by the identifier the system derives from the volume serial number
// the format wrote. Formatting the card again, anywhere, gives it a new serial and so a new
// key: an entry can only ever describe the format it was recorded for.
package ledger

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/probe"
)

const maxEntries = 1000

// Entry is one prepared card.
type Entry struct {
	PreparedAt   time.Time             `json:"preparedAt"`
	DeviceBytes  int64                 `json:"deviceBytes"`
	ClusterBytes int64                 `json:"clusterBytes"`
	Label        string                `json:"label"`
	VolumeSerial string                `json:"volumeSerial,omitempty"`
	Capacity     *probe.CapacityReport `json:"capacity,omitempty"`
	Latency      *probe.LatencyReport  `json:"latency,omitempty"`
}

// Store is the ledger file in a directory.
type Store struct {
	Dir string
	mu  sync.Mutex
}

// Key identifies one format of one card.
func Key(volumeUUID string, deviceBytes int64) string {
	return fmt.Sprintf("%s:%d", volumeUUID, deviceBytes)
}

func (s *Store) path() string { return filepath.Join(s.Dir, "cards.json") }

func (s *Store) load() map[string]Entry {
	entries := map[string]Entry{}
	if raw, err := os.ReadFile(s.path()); err == nil {
		json.Unmarshal(raw, &entries)
	}
	return entries
}

// Lookup returns the entry for a key, if this computer prepared that card.
func (s *Store) Lookup(key string) *Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	if entry, ok := s.load()[key]; ok {
		return &entry
	}
	return nil
}

// Record stores an entry, dropping the oldest beyond maxEntries.
func (s *Store) Record(key string, entry Entry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries := s.load()
	entries[key] = entry
	if len(entries) > maxEntries {
		keys := make([]string, 0, len(entries))
		for k := range entries {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return entries[keys[i]].PreparedAt.Before(entries[keys[j]].PreparedAt) })
		for _, k := range keys[:len(entries)-maxEntries] {
			delete(entries, k)
		}
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	raw, _ := json.MarshalIndent(entries, "", " ")
	temporary := s.path() + ".tmp"
	if err := os.WriteFile(temporary, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, s.path())
}
