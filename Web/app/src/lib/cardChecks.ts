import type { CardContents } from './card';

/**
 * What is worth saying about a folder before a configuration is written into it.
 *
 * The browser's folder picker will hand over any folder at all, so the page cannot know it
 * was given an SD card. These are the two mistakes that actually happen: choosing the
 * device's own folder on the card instead of the card itself — where the device never looks
 * for `_a3em.cfg` — and choosing some other folder entirely. And one thing that is not a
 * mistake but costs the next deployment: a card that still holds the last one's recordings.
 */
export interface CardCheck {
  severity: 'error' | 'warning';
  message: string;
}

const ACTIVATION_DIRECTORY = /^Activation_\d+$/;
const A3EM_ROOT_FILES = new Set(['_a3em.cfg', '_a3em.dev', '_a3em.test.results', 'boot.log', '_a3em.boot.txt']);
/** Fewer files than this at the top of a folder is an empty card, not a stranger's folder. */
const FOREIGN_FILE_THRESHOLD = 20;

/** Checks against a card that has been scanned in full. */
export function cardChecks(contents: CardContents | null): CardCheck[] {
  if (!contents) return [];
  const paths = contents.entries.map((entry) => entry.path);
  const segments = paths.map((path) => path.split('/'));
  return checksFrom({
    deviceFolder: segments.some((parts) => parts.length > 1 && ACTIVATION_DIRECTORY.test(parts[0])),
    markers: segments.some(
      (parts) => (parts.length === 1 && A3EM_ROOT_FILES.has(parts[0])) || (parts.length > 2 && ACTIVATION_DIRECTORY.test(parts[1])),
    ),
    fileCount: paths.length,
    recordings: contents.layout.files.filter((file) => file.kind === 'audio').length,
  });
}

/**
 * The same checks from a look at the top two levels only, for batch preparation, where a
 * full scan of every card in turn would take longer than the preparation itself.
 */
export async function quickCardChecks(root: FileSystemDirectoryHandle): Promise<CardCheck[]> {
  let deviceFolder = false;
  let markers = false;
  let earlierDeployment = false;
  let fileCount = 0;
  try {
    for await (const [name, handle] of (root as unknown as {
      entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries()) {
      if (name.startsWith('.')) continue;
      if (handle.kind === 'file') {
        fileCount++;
        if (A3EM_ROOT_FILES.has(name)) markers = true;
        continue;
      }
      if (ACTIVATION_DIRECTORY.test(name)) {
        deviceFolder = true;
        continue;
      }
      // A label folder holding activations is a previous deployment's recordings.
      for await (const [child, childHandle] of (handle as unknown as {
        entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
      }).entries()) {
        if (childHandle.kind === 'directory' && ACTIVATION_DIRECTORY.test(child)) {
          markers = true;
          earlierDeployment = true;
          break;
        }
      }
    }
  } catch {
    return [];
  }
  return checksFrom({ deviceFolder, markers, fileCount, recordings: earlierDeployment ? 1 : 0 }, true);
}

function checksFrom(
  found: { deviceFolder: boolean; markers: boolean; fileCount: number; recordings: number },
  approximate = false,
): CardCheck[] {
  const checks: CardCheck[] = [];
  if (found.deviceFolder) {
    checks.push({
      severity: 'error',
      message:
        "This is a device's folder on the card, not the card itself. The device only reads a " +
        'configuration from the top of the card, so choose the card instead.',
    });
  } else if (!found.markers && found.fileCount >= FOREIGN_FILE_THRESHOLD) {
    checks.push({
      severity: 'warning',
      message:
        `This folder does not look like an SD card: it holds ${found.fileCount.toLocaleString()} files and nothing ` +
        'an A3EM device writes. Check that you chose the card itself.',
    });
  }
  if (found.recordings > 0) {
    checks.push({
      severity: 'warning',
      message: approximate
        ? 'This card still holds recordings from an earlier deployment. Copy them off before reusing it — they ' +
          'also take space the forecast assumes is free.'
        : `This card still holds ${found.recordings.toLocaleString()} recordings from an earlier deployment. Copy ` +
          'them off in Check & copy before reusing it — they also take space the forecast assumes is free.',
    });
  }
  return checks;
}
