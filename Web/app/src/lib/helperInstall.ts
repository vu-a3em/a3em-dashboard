/**
 * What to tell someone who could install the card helper but has not.
 *
 * Two pieces have to be installed, and conflating them is the main way this gets
 * confusing: a **browser extension** from the Chrome Web Store, and a **native helper**
 * that the extension talks to. Neither works alone, and they are installed in different
 * places by different mechanisms.
 *
 * Nothing here is shown unless the browser can actually use it. Offering an installer to
 * someone on Firefox is worse than saying nothing.
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

export interface InstallStep {
  title: string;
  detail: string;
  /** A command to run, where the step is a command. */
  command?: string;
  /** A download or page, where the step is one. */
  link?: { label: string; href: string };
}

export interface InstallGuide {
  os: HostOs;
  osLabel: string;
  /** False where there is no helper for this system at all. */
  helperAvailable: boolean;
  /** Said plainly at the top when something about this system limits the helper. */
  caveat: string | null;
  steps: InstallStep[];
}

/**
 * The Chrome Web Store listing.
 *
 * Null until the extension is actually published — and rendered as "not yet available"
 * rather than as a dead link, because a link that 404s is worse than an honest absence.
 */
export const EXTENSION_STORE_URL: string | null = "https://chromewebstore.google.com/detail/a3em-card-helper/fccaomdnpebkiakcflkdgidnnodpalik";

/**
 * Where the helper's installers are published: GitHub releases of this repository, built and
 * signed by the card-helper-release workflow.
 *
 * Asset names carry no version, so `latest/download/<name>` always fetches the newest.
 */
export const HELPER_RELEASES_URL = 'https://github.com/vu-a3em/a3em-dashboard/releases/latest';
const download = (asset: string) => `${HELPER_RELEASES_URL}/download/${asset}`;

/** Kept for callers that want one link: the release page, which lists every platform. */
export const HELPER_DOWNLOAD_URL: string | null = HELPER_RELEASES_URL;

const extensionStep: InstallStep = {
  title: 'Install the browser extension',
  detail: EXTENSION_STORE_URL
    ? 'Available on the Chrome Web Store. It interacts with the card helper and holds no logic of its own.'
    : 'Not yet published to the Chrome Web Store. For now, load it unpacked: download the ' +
      'dashboard source, open chrome://extensions (edge://extensions in Edge), turn on Developer ' +
      'mode, choose "Load unpacked", and select its Web/extension folder.',
  link: EXTENSION_STORE_URL ? { label: 'Open the Chrome Web Store', href: EXTENSION_STORE_URL } : undefined,
};

const reloadStep: InstallStep = {
  title: 'Reload this page',
  detail: 'Card tools should show as ready at the bottom of the menu.',
};

function doctorStep(command: string): InstallStep {
  return {
    title: 'If there is a problem',
    detail: 'Use the following command to report which browsers the helper is registered with, and whether it runs:',
    command,
  };
}

export function installGuide(os: HostOs = detectOs()): InstallGuide {
  switch (os) {
    case 'macos':
      return {
        os,
        osLabel: 'macOS',
        helperAvailable: true,
        caveat: null,
        steps: [
          {
            title: 'Install the card helper',
            detail:
              'Open the downloaded installer and follow the instructions. It is signed and notarized by Apple, and ' +
              'registers the helper with Chrome, Edge, Chromium, Brave, Vivaldi, Opera, and Arc. The helper asks ' +
              'for your password each time it writes to a card.',
            link: { label: 'Download for macOS', href: download('A3EM-Card-Helper-macOS.pkg') },
          },
          extensionStep,
          reloadStep,
          doctorStep('"/Library/Application Support/A3EM/a3em-card-helper" doctor'),
        ],
      };
    case 'windows':
      return {
        os,
        osLabel: 'Windows',
        helperAvailable: true,
        caveat: null,
        steps: [
          {
            title: 'Install the card helper',
            detail:
              'Run the downloaded installer. It installs for you only and needs no administrator ' +
              'rights; Windows asks for permission each time the helper writes to a card.',
            link: { label: 'Download for Windows', href: download('A3EM-Card-Helper-Windows.exe') },
          },
          extensionStep,
          reloadStep,
          doctorStep('& "$env:LOCALAPPDATA\\Programs\\A3EM Card Helper\\a3em-card-helper.exe" doctor'),
        ],
      };
    case 'linux':
      return {
        os,
        osLabel: 'Linux',
        helperAvailable: true,
        caveat:
          'Chromium installed as a snap cannot start helpers like this one. Use Chrome, Edge, or a ' +
          'Chromium package from your distribution.',
        steps: [
          {
            title: 'Install the card helper',
            detail:
              'On Debian or Ubuntu, install the .deb for your processor (amd64 for most computers). ' +
              'For other distributions, the release page has a tarball with an install script. ' +
              'Formatting and checking need the exfatprogs package.',
            command: 'sudo apt install ./a3em-card-helper_amd64.deb',
            link: { label: 'Download the .deb (amd64)', href: download('a3em-card-helper_amd64.deb') },
          },
          extensionStep,
          reloadStep,
          doctorStep('a3em-card-helper doctor'),
        ],
      };
    default:
      return {
        os,
        osLabel: 'this system',
        helperAvailable: false,
        caveat: 'The card helper runs on macOS, Windows, and Linux.',
        steps: [extensionStep],
      };
  }
}
