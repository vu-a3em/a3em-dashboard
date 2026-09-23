package jobs

import (
	"bufio"
	"fmt"
	"os"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/blockdev"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/platform"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/safety"
)

// ImageReport is the result of copying a card to a file.
type ImageReport struct {
	DestinationPath string `json:"destinationPath"`
	BytesCopied     int64  `json:"bytesCopied"`
	// BadSectors could not be read and were written as zeros.
	BadSectors int64 `json:"badSectors"`
	Complete   bool  `json:"complete"`
}

const (
	imageChunk = 4 * 1024 * 1024
	sector     = 512
)

// image copies a whole card to a file, continuing past unreadable sectors.
//
// A failing card is exactly when this runs, and stopping at the first bad sector would abandon
// everything after it. A chunk that will not read is re-read a sector at a time, so one bad
// sector costs one sector — the difference between losing a clip and losing a day.
func image(job Job, plat platform.Platform, report Reporter) Result {
	if len(job.Targets) != 1 {
		return Result{Error: "An image is made of one card.", Code: "bad-request"}
	}
	target := job.Targets[0]
	devices, err := plat.ListDevices()
	if err != nil {
		return failure(err)
	}
	if err := recheck(devices, target); err != nil {
		return failure(err)
	}
	dev, err := blockdev.Open(target.RawPath, target.Device.SizeBytes, false)
	if err != nil {
		return failure(err)
	}
	defer dev.Close()

	out, err := os.OpenFile(job.Destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return failure(&safety.Refused{Message: fmt.Sprintf("Could not create %s: %v", job.Destination, err), Code: "bad-destination"})
	}
	chown(job.Destination, job.Owner)
	sink := bufio.NewWriterSize(out, imageChunk)
	buffer := blockdev.Aligned(imageChunk)
	total := dev.Size()
	var position, bad int64
	last := time.Time{}
	for position < total {
		want := int64(imageChunk)
		if total-position < want {
			want = total - position
		}
		chunk := buffer[:want]
		if _, err := dev.ReadAt(chunk, position); err != nil {
			for offset := int64(0); offset < want; offset += sector {
				piece := chunk[offset : offset+sector]
				if _, err := dev.ReadAt(piece, position+offset); err != nil {
					clear(piece)
					bad++
				}
			}
		}
		if _, err := sink.Write(chunk); err != nil {
			out.Close()
			return failure(&Failed{fmt.Sprintf("Could not write the image: %v", err), "bad-destination", ""})
		}
		position += want
		if time.Since(last) > 500*time.Millisecond || position == total {
			last = time.Now()
			report(Update{Device: target.Device.ID, Stage: "image", Note: notes["image"], Done: position, Total: total, BadSectors: bad})
		}
	}
	if err := sink.Flush(); err != nil {
		out.Close()
		return failure(err)
	}
	if err := out.Close(); err != nil {
		return failure(err)
	}
	return Result{Image: &ImageReport{DestinationPath: job.Destination, BytesCopied: position, BadSectors: bad, Complete: bad == 0 && position == total}}
}
