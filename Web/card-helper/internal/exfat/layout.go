// Package exfat builds an A3EM card's exFAT volume byte for byte, and checks a card against it.
//
// Ported from exfat_image.py, a Python formatter (since retired) that recovered the layout from
// known-good cards; the dashboard's schema (card-capacity.ts) computes the same geometry for its
// storage forecast. This package is now the reference. Nothing is left to a platform formatter: newfs_exfat, mkfs.exfat and Windows
// format each choose their own offsets, FAT placement and alignment. Every structure is
// assembled here, so a card formatted on any operating system carries the same bytes, and
// can be verified against the code that made it.
//
//	FatOffset          = 2048 sectors (1 MiB aligned)
//	FatLength          = ceil((approx_clusters + 2) * 4 / 512), rounded up to a whole cluster
//	ClusterHeapOffset  = (FatOffset + FatLength) rounded up to 2048 sectors
//	ClusterCount       = (VolumeLength - ClusterHeapOffset) / SectorsPerCluster
//
// where approx_clusters = (VolumeLength - FatOffset) / SectorsPerCluster, and the volume
// begins 2 MiB into the card.
package exfat

import (
	"fmt"
	"math/bits"
)

const (
	BytesPerSector       = 512
	PartitionStartSector = 4096
	AlignmentSectors     = 2048
	MinClusterBytes      = 512
	MaxClusterBytes      = 32 * 1024 * 1024
	DefaultLabel         = "A3EM"
	MaxLabelCharacters   = 11
	// LeadingBytes is the first MiB, holding the MBR, which is written last.
	LeadingBytes = 1024 * 1024
)

// Layout is every derived geometry value for one card capacity and cluster size.
type Layout struct {
	DiskSectors              int64
	ClusterBytes             int64
	SectorsPerCluster        int64
	SectorsPerClusterShift   int
	VolumeSectors            int64
	FatOffsetSectors         int64
	FatLengthSectors         int64
	ClusterHeapOffsetSectors int64
	ClusterCount             int64
	BitmapBytes              int64
	BitmapClusters           int64
	UpcaseClusters           int64
	BitmapCluster            int64
	UpcaseCluster            int64
	RootCluster              int64
	MetadataClusters         int64
	ZeroThroughSector        int64
	FreeBytes                int64
}

func roundUp(value, multiple int64) int64 { return (value + multiple - 1) / multiple * multiple }

// CheckClusterBytes reports whether exFAT can use this cluster size at all.
func CheckClusterBytes(clusterBytes int64) error {
	if clusterBytes < MinClusterBytes || clusterBytes > MaxClusterBytes || clusterBytes&(clusterBytes-1) != 0 {
		return fmt.Errorf("cluster size must be a power of two from %d bytes to 32 MB, not %d", MinClusterBytes, clusterBytes)
	}
	return nil
}

// NewLayout computes the layout the formatter produces for a card of diskBytes.
func NewLayout(diskBytes, clusterBytes int64) (Layout, error) {
	if err := CheckClusterBytes(clusterBytes); err != nil {
		return Layout{}, err
	}
	diskSectors := diskBytes / BytesPerSector
	if diskSectors <= PartitionStartSector+AlignmentSectors*4 {
		return Layout{}, fmt.Errorf("the card is too small to hold a volume")
	}
	spc := clusterBytes / BytesPerSector
	l := Layout{
		DiskSectors:            diskSectors,
		ClusterBytes:           clusterBytes,
		SectorsPerCluster:      spc,
		SectorsPerClusterShift: bits.TrailingZeros64(uint64(spc)),
		VolumeSectors:          diskSectors - PartitionStartSector,
		FatOffsetSectors:       AlignmentSectors,
	}
	approxClusters := (l.VolumeSectors - l.FatOffsetSectors) / spc
	fatBytes := (approxClusters + 2) * 4
	l.FatLengthSectors = roundUp(roundUp(fatBytes, BytesPerSector)/BytesPerSector, spc)
	l.ClusterHeapOffsetSectors = roundUp(l.FatOffsetSectors+l.FatLengthSectors, AlignmentSectors)
	l.ClusterCount = (l.VolumeSectors - l.ClusterHeapOffsetSectors) / spc
	if l.ClusterCount < 16 || l.ClusterCount > 0x7ffffffd {
		direction := "smaller"
		if l.ClusterCount > 16 {
			direction = "larger"
		}
		return Layout{}, fmt.Errorf("a %d-byte cluster gives %d clusters on this card, outside what exFAT allows; choose a %s cluster size",
			clusterBytes, l.ClusterCount, direction)
	}
	l.BitmapBytes = roundUp(l.ClusterCount, 8) / 8
	l.BitmapClusters = roundUp(l.BitmapBytes, clusterBytes) / clusterBytes
	l.UpcaseClusters = roundUp(int64(len(UpcaseTable())), clusterBytes) / clusterBytes
	l.MetadataClusters = l.BitmapClusters + l.UpcaseClusters + 1
	l.BitmapCluster = 2
	l.UpcaseCluster = l.BitmapCluster + l.BitmapClusters
	l.RootCluster = l.UpcaseCluster + l.UpcaseClusters
	l.ZeroThroughSector = l.ClusterSector(l.RootCluster) + spc
	free := l.ClusterCount - l.MetadataClusters
	if free < 0 {
		free = 0
	}
	l.FreeBytes = free * clusterBytes
	return l, nil
}

// ClusterSector is the absolute sector of a cluster, counted from the start of the card.
func (l Layout) ClusterSector(cluster int64) int64 {
	return PartitionStartSector + l.ClusterHeapOffsetSectors + (cluster-2)*l.SectorsPerCluster
}
