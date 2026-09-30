// Package copyout copies a card's files off it, as the person using the computer.
//
// This is the same job the page can do through the File System Access API, moved here
// because on Windows that API is slow in a way no amount of care in the page can fix:
// Chrome writes each file to a `.crswap` temporary beside the target and renames it on
// close, so every clip costs several filesystem operations plus a flush, all crossing the
// browser's IPC and permission boundary. A card holding tens of thousands of recordings
// pays that toll tens of thousands of times. Copying here is an ordinary sequential read
// and write.
//
// It deliberately does NOT decide what to copy. The page walks the card, judges what is a
// recording, applies a clock correction to the names, and hands over the resulting list;
// those rules live in the dashboard's schema package with their tests, and reimplementing
// them here would mean two answers to the same question. This package is told what to move
// and where, and moves it.
//
// No elevation: both sides are reachable as the ordinary user, so unlike imaging or
// formatting this never goes through the privileged worker.
package copyout

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// File is one file to copy, named relative to the source and the destination roots.
type File struct {
	From string `json:"from"`
	To   string `json:"to"`
	// Bytes is what the page measured, used to decide whether a file already at the
	// destination is the same one and can be left alone.
	Bytes int64 `json:"bytes"`
	// Append is written after the file's own bytes, for a recording the device never
	// closed: the page recovered it from the filesystem and the card is not written to.
	Append []byte `json:"append,omitempty"`
	// Replace writes only Append, for a file whose recorded length is a lie.
	Replace bool `json:"replace,omitempty"`
	/*
		Patch is written into the copy at fixed offsets once its bytes are there.

		A recording the device never closed carries zeros where its own length should be,
		and mending it is two little-endian uint32 writes into the header. The page decides
		the numbers, having judged the file; this puts them in the copy, so the card keeps
		the header the device actually wrote.
	*/
	Patch []Patch `json:"patch,omitempty"`
}

// Patch is bytes to write at an offset inside a copied file.
type Patch struct {
	Offset int64  `json:"offset"`
	Bytes  []byte `json:"bytes"`
}

// Skipped is one file that could not be copied, and why.
type Skipped struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// Report is what a copy did. It has to fit in a 1 MB reply alongside everything else, so it
// carries counts and the failures rather than a line per file: a copy that works has nothing
// per-file worth saying, and one that fails has few.
type Report struct {
	Copied         int       `json:"copied"`
	AlreadyPresent int       `json:"alreadyPresent"`
	BytesCopied    int64     `json:"bytesCopied"`
	Recovered      []string  `json:"recovered,omitempty"`
	Skipped        []Skipped `json:"skipped,omitempty"`
	Canceled       bool      `json:"canceled"`
	// SkippedTruncated is set when there were more failures than the reply can carry.
	SkippedTruncated bool `json:"skippedTruncated,omitempty"`
}

// maxSkipped keeps the reply inside Chrome's 1 MB limit. A copy that fails this many times
// has something wrong with it that the first few hundred already show.
const maxSkipped = 500

// maxRecovered bounds the same reply. The page knows the full list; this is confirmation.
const maxRecovered = 500

const bufferBytes = 4 * 1024 * 1024

// Progress is reported as the copy runs.
type Progress struct {
	FilesDone   int
	FilesTotal  int
	BytesDone   int64
	BytesTotal  int64
	CurrentPath string
}

// Options are everything a copy needs besides its file list.
type Options struct {
	Source      string
	Destination string
	// Stop, closed, ends the copy between files. What was copied stays.
	Stop <-chan struct{}
	// Report is called as files land, thinned by the caller if it forwards them onward.
	Report func(Progress)
	// Owner chowns what is created, for a helper running as root on someone's behalf.
	Chown func(path string)
}

// Run copies the listed files. It never stops at the first failure: a card being copied is
// often a card with something wrong, and abandoning the rest to save the report would lose
// the recordings the copy exists to rescue.
func Run(files []File, opts Options) (Report, error) {
	report := Report{}
	if opts.Source == "" || opts.Destination == "" {
		return report, errors.New("a copy needs both a source and a destination")
	}
	var bytesTotal int64
	for _, file := range files {
		bytesTotal += file.Bytes
	}

	// One listing per destination directory instead of a probe per file. Copying into an
	// empty folder is the ordinary case, and it used to spend two filesystem round trips
	// per file learning that the folder was empty.
	seen := map[string]map[string]int64{}
	made := map[string]bool{}
	buf := make([]byte, bufferBytes)
	lastReport := time.Time{}

	for index, file := range files {
		if stopped(opts.Stop) {
			report.Canceled = true
			break
		}
		if opts.Report != nil && (time.Since(lastReport) >= 200*time.Millisecond || index == 0) {
			lastReport = time.Now()
			opts.Report(Progress{FilesDone: index, FilesTotal: len(files), BytesDone: report.BytesCopied,
				BytesTotal: bytesTotal, CurrentPath: file.From})
		}

		from, err := safeJoin(opts.Source, file.From)
		if err != nil {
			report.note(file.From, err)
			continue
		}
		to, err := safeJoin(opts.Destination, file.To)
		if err != nil {
			report.note(file.From, err)
			continue
		}

		dir := filepath.Dir(to)
		if !made[dir] {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				report.note(file.From, err)
				continue
			}
			made[dir] = true
			if opts.Chown != nil {
				opts.Chown(dir)
			}
		}
		if _, ok := seen[dir]; !ok {
			seen[dir] = listSizes(dir)
		}

		// A file already there at the length this copy would write is the same file, from a
		// run that stopped partway. Skipping it is what makes a copy resumable.
		expected := file.Bytes + int64(len(file.Append))
		if file.Replace {
			expected = int64(len(file.Append))
		}
		if size, ok := seen[dir][filepath.Base(to)]; ok && size == expected {
			report.AlreadyPresent++
			report.BytesCopied += file.Bytes
			if len(file.Append) > 0 {
				report.recover(file.From)
			}
			continue
		}

		if err := copyOne(from, to, file, buf, opts.Chown); err != nil {
			report.note(file.From, err)
			continue
		}
		seen[dir][filepath.Base(to)] = expected
		report.Copied++
		report.BytesCopied += file.Bytes
		if len(file.Append) > 0 {
			report.recover(file.From)
		}
	}

	if opts.Report != nil {
		opts.Report(Progress{FilesDone: len(files), FilesTotal: len(files), BytesDone: report.BytesCopied,
			BytesTotal: bytesTotal})
	}
	return report, nil
}

// copyOne writes through a temporary in the destination directory, so an interrupted copy
// never leaves a short file that the next run would mistake for a whole one.
func copyOne(from, to string, file File, buf []byte, chown func(string)) error {
	partial := to + ".a3em-partial"
	os.Remove(partial)
	out, err := os.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if chown != nil {
		chown(partial)
	}
	cleanup := func() {
		out.Close()
		os.Remove(partial)
	}

	if !file.Replace {
		in, err := os.Open(from)
		if err != nil {
			cleanup()
			return err
		}
		_, err = io.CopyBuffer(out, in, buf)
		in.Close()
		if err != nil {
			cleanup()
			return err
		}
	}
	if len(file.Append) > 0 {
		if _, err := out.Write(file.Append); err != nil {
			cleanup()
			return err
		}
	}
	for _, patch := range file.Patch {
		if patch.Offset < 0 {
			cleanup()
			return fmt.Errorf("a patch at offset %d", patch.Offset)
		}
		if _, err := out.WriteAt(patch.Bytes, patch.Offset); err != nil {
			cleanup()
			return err
		}
	}
	if err := out.Close(); err != nil {
		os.Remove(partial)
		return err
	}
	if err := os.Rename(partial, to); err != nil {
		os.Remove(partial)
		return err
	}
	return nil
}

// listSizes is what a destination directory already holds, by name.
func listSizes(dir string) map[string]int64 {
	sizes := map[string]int64{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return sizes
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if info, err := entry.Info(); err == nil {
			sizes[entry.Name()] = info.Size()
		}
	}
	return sizes
}

// safeJoin keeps a relative path inside its root, so a name from the page cannot reach out
// of the folder the person chose.
func safeJoin(root, rel string) (string, error) {
	if rel == "" {
		return "", errors.New("a file with no name")
	}
	if filepath.IsAbs(rel) || strings.HasPrefix(rel, `\`) {
		return "", fmt.Errorf("%s is not a relative path", rel)
	}
	clean := filepath.Clean(filepath.FromSlash(rel))
	joined := filepath.Join(root, clean)
	prefix := root + string(os.PathSeparator)
	if joined != root && !strings.HasPrefix(joined, prefix) {
		return "", fmt.Errorf("%s points outside the folder", rel)
	}
	return joined, nil
}

func stopped(stop <-chan struct{}) bool {
	if stop == nil {
		return false
	}
	select {
	case <-stop:
		return true
	default:
		return false
	}
}

func (r *Report) note(path string, err error) {
	if len(r.Skipped) >= maxSkipped {
		r.SkippedTruncated = true
		return
	}
	r.Skipped = append(r.Skipped, Skipped{Path: path, Reason: err.Error()})
}

func (r *Report) recover(path string) {
	if len(r.Recovered) < maxRecovered {
		r.Recovered = append(r.Recovered, path)
	}
}

// SortForLocality orders files by directory so a copy reads a card the way it was written,
// rather than seeking between folders for every file.
func SortForLocality(files []File) {
	sort.SliceStable(files, func(a, b int) bool { return files[a].From < files[b].From })
}
