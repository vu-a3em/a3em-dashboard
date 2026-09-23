package dispatch

import "github.com/vu-a3em/a3em-dashboard/card-helper/internal/blockdev"

func blockOpen(path string) (blockdev.Device, error) { return blockdev.OpenFile(path, false) }
