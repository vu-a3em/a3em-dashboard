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
}

export interface InstallGuide {
  os: HostOs;
  osLabel: string;
  /** False where the native helper has no implementation for this OS yet. */
  helperAvailable: boolean;
  /** Said plainly at the top when the helper cannot do anything here yet. */
  caveat: string | null;
  steps: InstallStep[];
}

/**
 * The Chrome Web Store listing.
 *
 * Null until the extension is actually published — and rendered as "not yet available"
 * rather than as a dead link, because a link that 404s is worse than an honest absence.
 */
export const EXTENSION_STORE_URL: string | null = null;

/** Where the native helper installer is downloaded from. Null until one is published. */
export const HELPER_DOWNLOAD_URL: string | null = null;

/**
 * The extension's fixed ID, so the install command is copy-pasteable as written.
 *
 * Pinned by the public key in the extension manifest, which means it is the same whether
 * the extension came from the Web Store or was loaded unpacked — so there is no step
 * where someone has to go and find their own ID first.
 */
const EXTENSION_ID = 'felbcgjkphldokgcjildnmnclokfngnh';

const REPOSITORY_URL = 'https://github.com/vu-a3em/a3em-dashboard.git';

/**
 * The steps, in the words and the shell of the system they are for.
 *
 * Everything funnels through npm, so the commands barely differ; what differs is where they
 * are typed, what the helper can do there, and — on Windows — that registering it with the
 * browser is a registry change the installer prints rather than makes.
 */
function sourceSteps(os: 'macos' | 'windows' | 'linux'): InstallStep[] {
  const shell = os === 'windows' ? 'PowerShell' : os === 'macos' ? 'Terminal' : 'a terminal';
  const steps: InstallStep[] = [
    {
      title: 'Get the dashboard source',
      detail: `Needs Git and Node.js 20 or later. In ${shell}:`,
      command: `git clone ${REPOSITORY_URL}\ncd a3em-dashboard/Web\nnpm install`,
    },
    {
      title: 'Build and register the helper',
      detail:
        os === 'windows'
          ? 'From the same folder. This builds the helper and writes its manifest, then prints the ' +
            'registry commands that tell each browser where to find it.'
          : 'From the same folder. This builds the native helper and registers it with every ' +
            'Chromium browser it finds, then verifies the registration by running it.',
      command: 'npm --workspace @a3em/card-helper run build\n' + `npm run install-helper -- --extension-id ${EXTENSION_ID}`,
    },
  ];
  if (os === 'windows') {
    steps.push({
      title: 'Register it with the browser',
      detail:
        'Run the reg add commands the previous step printed, in the same PowerShell window. They ' +
        'write to your own user registry and need no administrator rights.',
    });
  }
  steps.push({
    title: 'Check it worked',
    detail:
      os === 'windows'
        ? 'Reports whether the helper actually runs. It cannot read the registry, so if the dashboard ' +
          'still cannot find the helper, re-run the reg add commands above.'
        : 'Reports which browsers were wired up and whether the helper actually runs. A registration ' +
          'that silently did not take is otherwise only discovered with a card in hand.',
    command: 'npm run helper-doctor',
  });
  return steps;
}

export function installGuide(os: HostOs = detectOs()): InstallGuide {
  const extensionStep: InstallStep = {
    title: 'Install the browser extension',
    detail: EXTENSION_STORE_URL
      ? 'From the Chrome Web Store. It is a small relay — it holds no card logic of its own.'
      : 'Not yet published to the Chrome Web Store. For now, load it unpacked: open ' +
        'chrome://extensions (edge://extensions in Edge), turn on Developer mode, choose "Load unpacked", ' +
        'and select the Web/extension folder in the copy you just downloaded.',
  };

  switch (os) {
    case 'macos':
      return {
        os,
        osLabel: 'macOS',
        helperAvailable: true,
        caveat: null,
        steps: [...sourceSteps('macos').slice(0, 1), extensionStep, ...sourceSteps('macos').slice(1)],
      };
    case 'windows':
      return {
        os,
        osLabel: 'Windows',
        helperAvailable: false,
        caveat:
          'The native helper does not support Windows yet. The extension installs and the ' +
          'connection works, but every card operation will report which command still needs ' +
          'implementing. macOS is complete.',
        steps: [...sourceSteps('windows').slice(0, 1), extensionStep, ...sourceSteps('windows').slice(1)],
      };
    case 'linux':
      return {
        os,
        osLabel: 'Linux',
        helperAvailable: false,
        caveat:
          'The native helper does not support Linux yet. The extension installs and the ' +
          'connection works, but every card operation will report which command still needs ' +
          'implementing. macOS is complete.',
        steps: [...sourceSteps('linux').slice(0, 1), extensionStep, ...sourceSteps('linux').slice(1)],
      };
    default:
      return {
        os,
        osLabel: 'this system',
        helperAvailable: false,
        caveat: 'The card helper supports macOS, Windows, and Linux.',
        steps: [extensionStep],
      };
  }
}
