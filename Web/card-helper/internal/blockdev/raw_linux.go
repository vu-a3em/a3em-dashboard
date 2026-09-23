package blockdev

import (
	"os"
	"syscall"
)

const directFlag = syscall.O_DIRECT

func afterOpen(_ *os.File) error { return nil }
