/**
 * The operating system the browser runs on, for instructions that differ by system. On its own,
 * apart from the install guide it began in, so what uses it does not bring the guide along.
 */

export type HostOs = 'macos' | 'windows' | 'linux' | 'unknown';

export function detectOs(): HostOs {
  if (typeof navigator === 'undefined') return 'unknown';
  const platform = (
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent
  ).toLowerCase();
  if (platform.includes('mac')) return 'macos';
  if (platform.includes('win')) return 'windows';
  if (platform.includes('linux') || platform.includes('x11')) return 'linux';
  return 'unknown';
}
