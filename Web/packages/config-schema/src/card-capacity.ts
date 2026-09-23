/**
 * How much of an SD card is actually available to recordings.
 *
 * The same geometry as the card helper's formatter (`card-helper/internal/exfat`), which
 * prepares cards for this project. It builds every exFAT structure itself rather than handing
 * the card to a platform formatter, so the geometry below is exactly what a card it formats
 * will carry — not an approximation of what `newfs_exfat` or Windows might choose. Both began
 * as ports of `exfat_image.py`, a Python formatter since retired.
 *
 * The layout was recovered from known-good cards at 4 kB clusters; every other cluster size
 * follows from the same rules, which is what lets this dashboard recommend one per deployment
 * and the card helper (`card-helper/internal/exfat`) write it:
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
/** The canonical compressed up-case table's length, as the formatter writes it. */
export const UPCASE_TABLE_BYTES = 5836;
/** The exFAT specification's largest cluster: 32 MB. */
export const MAX_CLUSTER_BYTES = 32 * 1024 * 1024;

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
  /** log2 of sectors per cluster, as the boot sector stores it. */
  sectorsPerClusterShift: number;
  /** The allocation bitmap, up-case table and root directory, in the order they sit in the heap. */
  bitmapBytes: number;
  bitmapClusters: number;
  upcaseClusters: number;
  bitmapCluster: number;
  upcaseCluster: number;
  rootCluster: number;
  /** Clusters the formatter itself occupies: bitmap, up-case table and root directory. */
  metadataClusters: number;
  /** The last sector the formatter's structures reach; everything before it is written or blanked. */
  zeroThroughSector: number;
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
  if (
    !Number.isInteger(clusterBytes) ||
    clusterBytes < BYTES_PER_SECTOR ||
    clusterBytes > MAX_CLUSTER_BYTES ||
    (clusterBytes & (clusterBytes - 1)) !== 0
  ) {
    throw new Error(`Cluster size ${clusterBytes} is not a power of two from ${BYTES_PER_SECTOR} bytes to 32 MB.`);
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
  if (clusterCount < 16 || clusterCount > 0x7ffffffd) {
    throw new Error(
      `A ${clusterBytes}-byte cluster gives ${clusterCount} clusters on this card, outside what exFAT allows. ` +
        `Choose a ${clusterCount > 16 ? 'larger' : 'smaller'} cluster size.`,
    );
  }

  const bitmapBytes = roundUp(clusterCount, 8) / 8;
  const bitmapClusters = roundUp(bitmapBytes, clusterBytes) / clusterBytes;
  const upcaseClusters = roundUp(UPCASE_TABLE_BYTES, clusterBytes) / clusterBytes;
  const metadataClusters = bitmapClusters + upcaseClusters + 1;
  const bitmapCluster = 2;
  const upcaseCluster = bitmapCluster + bitmapClusters;
  const rootCluster = upcaseCluster + upcaseClusters;

  return {
    diskSectors,
    clusterBytes,
    sectorsPerCluster,
    volumeSectors,
    fatOffsetSectors,
    fatLengthSectors,
    clusterHeapOffsetSectors,
    clusterCount,
    sectorsPerClusterShift: Math.log2(sectorsPerCluster),
    bitmapBytes,
    bitmapClusters,
    upcaseClusters,
    bitmapCluster,
    upcaseCluster,
    rootCluster,
    metadataClusters,
    zeroThroughSector:
      PARTITION_START_SECTOR + clusterHeapOffsetSectors + (rootCluster - 2) * sectorsPerCluster + sectorsPerCluster,
    freeBytes: Math.max(0, clusterCount - metadataClusters) * clusterBytes,
  };
}

/** Absolute sector of a cluster, counted from the start of the card. */
export function clusterSector(layout: ExfatLayout, cluster: number): number {
  return PARTITION_START_SECTOR + layout.clusterHeapOffsetSectors + (cluster - 2) * layout.sectorsPerCluster;
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
