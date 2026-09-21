#!/usr/bin/env node
/**
 * Installs the native messaging host manifest for every Chromium browser on this machine.
 *
 *   node tools/install-card-helper.mjs [--extension-id <id>] [--check] [--uninstall]
 *
 * A native messaging host is two things: a binary, and a manifest telling the browser
 * where that binary is and which extension may talk to it. The manifest is what goes
 * wrong — it is per-browser, in a different directory for each, and a browser that cannot
 * find it reports "Specified native messaging host not found", which is
 * indistinguishable in the page from the extension being broken.
 *
 * So this ends by *self-testing*: it spawns the host, exchanges a real length-prefixed
 * message, and reports what answered. An install that silently did not take is otherwise
 * only discovered by someone with a card in their hand.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'org.a3em.card_helper';
const here = dirname(fileURLToPath(import.meta.url));
const HOST_ENTRY = resolve(here, '..', 'packages', 'card-helper', 'dist', 'index.js');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

/**
 * Where each browser looks.
 *
 * Opera is absent deliberately: it reads Chrome's directory, so writing Chrome's manifest
 * covers it. Its own profile directory is an additional location it also honours, but it
 * varies per installation and the Chrome path is sufficient.
 */
const BROWSER_DIRECTORIES = {
  darwin: {
    Chrome: '~/Library/Application Support/Google/Chrome/NativeMessagingHosts',
    'Chrome Beta': '~/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts',
    Chromium: '~/Library/Application Support/Chromium/NativeMessagingHosts',
    Edge: '~/Library/Application Support/Microsoft Edge/NativeMessagingHosts',
    Brave: '~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts',
    Vivaldi: '~/Library/Application Support/Vivaldi/NativeMessagingHosts',
  },
  linux: {
    Chrome: '~/.config/google-chrome/NativeMessagingHosts',
    Chromium: '~/.config/chromium/NativeMessagingHosts',
    Edge: '~/.config/microsoft-edge/NativeMessagingHosts',
    Brave: '~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts',
    Vivaldi: '~/.config/vivaldi/NativeMessagingHosts',
  },
  // Windows uses the registry rather than a directory; see installWindows below.
  win32: {},
};

function expand(path) {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
}

function manifestFor(extensionId) {
  return {
    name: HOST_NAME,
    description: 'A3EM SD card helper',
    path: process.platform === 'win32' ? launcherPath() : HOST_ENTRY,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

/**
 * Windows cannot exec a .js file directly, so the manifest points at a .cmd shim.
 *
 * Written next to the built host rather than into a system directory, so uninstalling is
 * deleting a folder.
 */
function launcherPath() {
  return resolve(here, '..', 'packages', 'card-helper', 'dist', 'a3em-card-helper.cmd');
}

function writeWindowsLauncher() {
  const cmd = `@echo off\r\nnode "%~dp0index.js" %*\r\n`;
  writeFileSync(launcherPath(), cmd, 'utf8');
}

// ---------------------------------------------------------------------------

function install(extensionId) {
  if (!existsSync(HOST_ENTRY)) {
    fail(
      `The helper has not been built. Run:\n    npm --workspace @a3em/card-helper run build`,
    );
  }

  if (process.platform === 'win32') return installWindows(extensionId);

  const directories = BROWSER_DIRECTORIES[platform()] ?? {};
  const manifest = JSON.stringify(manifestFor(extensionId), null, 2);
  const installed = [];

  for (const [browser, directory] of Object.entries(directories)) {
    const target = expand(directory);
    // Only where the browser's own profile directory exists: creating a Brave config
    // folder on a machine without Brave is litter, and a browser that is installed later
    // is handled by running this again.
    if (!existsSync(dirname(target))) continue;
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, `${HOST_NAME}.json`), manifest, 'utf8');
    installed.push(browser);
  }

  if (installed.length === 0) {
    fail('No Chromium browser profile was found. Install Chrome, Edge, or Opera first.');
  }
  console.log(`Registered the native host for: ${installed.join(', ')}`);
  console.log(`  host:      ${HOST_ENTRY}`);
  console.log(`  extension: ${extensionId}`);
  return installed;
}

function installWindows(extensionId) {
  writeWindowsLauncher();
  const manifestPath = resolve(here, '..', 'packages', 'card-helper', 'dist', `${HOST_NAME}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifestFor(extensionId), null, 2), 'utf8');

  // HKCU rather than HKLM: no elevation needed, and the helper is per-user anyway.
  const keys = [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
    `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
  ];
  console.log('On Windows, run these to register the host:\n');
  for (const key of keys) {
    console.log(`  reg add "${key}" /ve /t REG_SZ /d "${manifestPath}" /f`);
  }
  console.log(
    '\nThis script does not write the registry itself — doing so from Node needs either a\n' +
      'native module or a shelled-out reg.exe whose failures are hard to report well. The\n' +
      'commands above are the whole of it, and an installer (MSI or Inno Setup) should run\n' +
      'them at install time.',
  );
  return ['Windows (manual step required)'];
}

function uninstall() {
  const directories = BROWSER_DIRECTORIES[platform()] ?? {};
  let removed = 0;
  for (const directory of Object.values(directories)) {
    const file = join(expand(directory), `${HOST_NAME}.json`);
    if (existsSync(file)) {
      rmSync(file);
      removed++;
    }
  }
  console.log(`Removed ${removed} native host manifest${removed === 1 ? '' : 's'}.`);
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/**
 * Speaks the real protocol to the real binary.
 *
 * Not a file-existence check: the failure this catches is a host that is registered,
 * present, and does not run — a missing Node, a broken build, a permissions problem on
 * the entry point. Those are invisible until a browser tries, and by then the error
 * surfaces in a page as "not installed".
 */
async function selfTest() {
  if (!existsSync(HOST_ENTRY)) {
    console.error(`✗ Host binary missing: ${HOST_ENTRY}`);
    console.error('  Run: npm --workspace @a3em/card-helper run build');
    return false;
  }

  const child = spawn(process.execPath, [HOST_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });

  const request = Buffer.from(JSON.stringify({ id: 'selftest', op: 'hello' }), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(request.length, 0);
  child.stdin.write(Buffer.concat([header, request]));

  const reply = await new Promise((resolveReply) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => resolveReply(null), 8000);
    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      clearTimeout(timer);
      resolveReply(JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')));
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolveReply(null);
    });
  });
  child.kill();

  if (!reply || reply.ok !== true) {
    console.error('✗ The host did not answer a hello. It is registered but will not run.');
    return false;
  }

  console.log(`✓ Host answered: v${reply.version} on ${reply.platform}`);
  if (reply.implemented.length === 0) {
    console.log(
      `⚠ No operations are implemented on ${reply.platform} yet — the transport works, but\n` +
        '  every card operation will report which command still needs writing. See\n' +
        `  packages/card-helper/src/platform/${reply.platform}.ts`,
    );
  } else {
    console.log(`  Implemented: ${reply.implemented.join(', ')}`);
  }
  return true;
}

function checkManifests() {
  if (process.platform === 'win32') {
    console.log('Registry check is not automated; see the reg add commands from --install.');
    return;
  }
  const directories = BROWSER_DIRECTORIES[platform()] ?? {};
  for (const [browser, directory] of Object.entries(directories)) {
    const file = join(expand(directory), `${HOST_NAME}.json`);
    if (!existsSync(file)) continue;
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      const pathOk = existsSync(manifest.path);
      console.log(
        `${pathOk ? '✓' : '✗'} ${browser}: ${manifest.allowed_origins?.[0] ?? 'no origin'}` +
          (pathOk ? '' : `  (host path missing: ${manifest.path})`),
      );
    } catch (error) {
      console.log(`✗ ${browser}: manifest is not readable — ${error.message}`);
    }
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------------------

if (flag('--uninstall')) {
  uninstall();
} else if (flag('--check')) {
  checkManifests();
  const ok = await selfTest();
  process.exit(ok ? 0 : 1);
} else {
  const extensionId = value('--extension-id') ?? process.env.A3EM_HELPER_EXTENSION_ID;
  if (!extensionId) {
    fail(
      'An extension ID is required:\n' +
        '    node tools/install-card-helper.mjs --extension-id <id>\n\n' +
        'It is shown on chrome://extensions with developer mode on, and is stable across\n' +
        'machines only when the extension carries a "key" in its manifest.',
    );
  }
  install(extensionId);
  const ok = await selfTest();
  process.exit(ok ? 0 : 1);
}
