/**
 * How much of an SD card is actually available to recordings.
 *
 * A PORT of the `Layout` class in `use-then-delete/exfat_image.py`, the formatter that will
 * prepare cards for this project. That tool builds every exFAT structure itself rather than
 * handing the card to a platform formatter, so the geometry below is exactly what a card it
 * formats will carry — not an approximation of what `newfs_exfat` or Windows might choose.
 *
 * It is written there for a fixed 4 kB cluster. The cluster size is a parameter here because
 * this dashboard recommends one per deployment, and every other quantity in the layout
 * follows from it by the same rules:
 *
 *     FatOffset          = 2048 sectors (1 MiB aligned)
 *     FatLength          = ceil((approx_clusters + 2) * 4 / 512), rounded up to one cluster
 *     ClusterHeapOffset  = (FatOffset + FatLength) rounded up to 2048 sectors
 *     ClusterCount       = (VolumeLength - ClusterHeapOffset) / SectorsPerCluster
 *
 * where approx_clusters = (VolumeLength - FatOffset) / SectorsPerCluster, and the volume
 * begins 2 MiB into the card. The allocation bitmap, the up-case table and the root
 * directory each occupy whole clusters at the start of the heap.
 *
 * Card capacity is taken as the marketed size in decimal gigabytes, which is how the SD
 * Association and every manufacturer state it. A real card's user area is often a little
 * below that figure, so a connected card's own report is preferred wherever one exists.
 */

export const BYTES_PER_SECTOR = 512;
/** The exFAT volume starts here, matching the reference cards. */
export const PARTITION_START_SECTOR = 4096;
/** FAT and cluster heap are aligned to 1 MiB. */
export const ALIGNMENT_SECTORS = 2048;
/** `len(UPCASE_TABLE)` in exfat_image.py: the canonical compressed up-case table. */
export const UPCASE_TABLE_BYTES = 5836;

/** Marketed card sizes are decimal. */
export const BYTES_PER_MARKETED_GB = 1_000_000_000;

export interface ExfatLayout {
  diskSectors: number;
  clusterBytes: number;
  sectorsPerCluster: number;
  volumeSectors: number;
  fatOffsetSectors: number;
  fatLengthSectors: number;
  clusterHeapOffsetSectors: number;
  clusterCount: number;
  /** Clusters the formatter itself occupies: bitmap, up-case table and root directory. */
  metadataClusters: number;
  /** What recordings can use on a freshly formatted card. */
  freeBytes: number;
}

const roundUp = (value: number, multiple: number) => Math.ceil(value / multiple) * multiple;

/**
 * The layout the formatter produces for a card of `diskBytes` at `clusterBytes`.
 *
 * Throws on a card too small to hold a volume, as the formatter does.
 */
export function exfatLayout(diskBytes: number, clusterBytes: number): ExfatLayout {
  if (!Number.isFinite(diskBytes) || diskBytes <= 0) throw new Error('Card capacity must be positive.');
  if (!Number.isInteger(clusterBytes) || clusterBytes < BYTES_PER_SECTOR || (clusterBytes & (clusterBytes - 1)) !== 0) {
    throw new Error(`Cluster size ${clusterBytes} is not a power of two of at least ${BYTES_PER_SECTOR} bytes.`);
  }
  const diskSectors = Math.floor(diskBytes / BYTES_PER_SECTOR);
  if (diskSectors <= PARTITION_START_SECTOR + ALIGNMENT_SECTORS * 4) {
    throw new Error('The card is too small to hold a volume.');
  }

  const sectorsPerCluster = clusterBytes / BYTES_PER_SECTOR;
  const volumeSectors = diskSectors - PARTITION_START_SECTOR;
  const fatOffsetSectors = ALIGNMENT_SECTORS;
  const approxClusters = Math.floor((volumeSectors - fatOffsetSectors) / sectorsPerCluster);
  const fatBytes = (approxClusters + 2) * 4;
  const fatLengthSectors = roundUp(roundUp(fatBytes, BYTES_PER_SECTOR) / BYTES_PER_SECTOR, sectorsPerCluster);
  const clusterHeapOffsetSectors = roundUp(fatOffsetSectors + fatLengthSectors, ALIGNMENT_SECTORS);
  const clusterCount = Math.floor((volumeSectors - clusterHeapOffsetSectors) / sectorsPerCluster);

  const bitmapBytes = roundUp(clusterCount, 8) / 8;
  const bitmapClusters = roundUp(bitmapBytes, clusterBytes) / clusterBytes;
  const upcaseClusters = roundUp(UPCASE_TABLE_BYTES, clusterBytes) / clusterBytes;
  const metadataClusters = bitmapClusters + upcaseClusters + 1;

  return {
    diskSectors,
    clusterBytes,
    sectorsPerCluster,
    volumeSectors,
    fatOffsetSectors,
    fatLengthSectors,
    clusterHeapOffsetSectors,
    clusterCount,
    metadataClusters,
    freeBytes: Math.max(0, clusterCount - metadataClusters) * clusterBytes,
  };
}

/** `exfatLayout` for a card sold as `gb` gigabytes. */
export function marketedCardLayout(gb: number, clusterBytes: number): ExfatLayout {
  return exfatLayout(gb * BYTES_PER_MARKETED_GB, clusterBytes);
}

// ---------------------------------------------------------------------------
// What each file costs on the card
// ---------------------------------------------------------------------------

/** exFAT directory entries are 32 bytes each. */
export const DIRECTORY_ENTRY_BYTES = 32;

/**
 * Directory space one name takes: a file entry, a stream extension, and one name entry per
 * fifteen UTF-16 characters.
 */
export function directoryEntryBytes(nameLength: number): number {
  return (2 + Math.ceil(Math.max(1, nameLength) / 15)) * DIRECTORY_ENTRY_BYTES;
}

/** Clusters a file of `bytes` occupies. An empty file still takes none; any content takes one. */
export function clustersFor(bytes: number, clusterBytes: number): number {
  return bytes > 0 ? Math.ceil(bytes / clusterBytes) : 0;
}

/**
 * Name lengths the firmware writes, from `storage.c`.
 *
 * Every recording is `<10-digit epoch>.<ext>`, and it lives four directories down:
 * `LABEL/Activation_NNNN/<10-digit UTC day>/<10-digit UTC 4-hour bucket>/`. Each bucket
 * directory also carries its own `a3em.log`, rotated in as the directory is created.
 */
export const RECORDING_NAME_LENGTH = 14; // "1767225600.wav", ".imu"; ".opus" is 15
export const BUCKET_DIRECTORY_NAME_LENGTH = 10;
export const BUCKET_LOG_NAME_LENGTH = 8; // "a3em.log"
