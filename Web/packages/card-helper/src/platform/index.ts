import { DarwinPlatform } from './darwin.js';
import { LinuxPlatform } from './linux.js';
import { Win32Platform } from './win32.js';
import type { Platform } from './types.js';

export * from './types.js';
export { DarwinPlatform } from './darwin.js';
export { LinuxPlatform } from './linux.js';
export { Win32Platform } from './win32.js';

/**
 * Picks the implementation for the machine this is running on.
 *
 * All three are constructed the same way and none does work in its constructor, so
 * selecting a platform cannot fail — an unimplemented one fails at the method that was
 * actually called, naming the command it needs. That is deliberate: the helper should
 * start, report itself, and enumerate its capabilities on any OS, so an operator on a
 * half-ported platform learns exactly which operations are missing rather than finding
 * the program will not run.
 */
export function platformFor(id: NodeJS.Platform = process.platform): Platform {
  switch (id) {
    case 'darwin':
      return new DarwinPlatform();
    case 'win32':
      return new Win32Platform();
    case 'linux':
      return new LinuxPlatform();
    default:
      throw new Error(
        `The A3EM card helper has no implementation for ${id}. Supported: macOS, Windows, Linux.`,
      );
  }
}

/** Which operations this build can actually perform here, for the `hello` handshake. */
export function implementedOperations(platform: Platform): string[] {
  // Implementation status is a property of the class, not something to probe by calling
  // methods that might act on a disk. Kept as an explicit list per platform.
  switch (platform.id) {
    case 'darwin':
      return [
        'listDevices',
        'inspect',
        'identify',
        'mount',
        'unmount',
        'eject',
        'diagnose',
        'repair',
        'image',
        'format',
      ];
    case 'win32':
    case 'linux':
      return [];
    default:
      return [];
  }
}
