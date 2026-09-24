#!/usr/bin/env node
/**
 * Writes `deployment.json` into the extension manifest and everything else that names the
 * extension, and checks none of it has drifted.
 *
 *   node tools/sync-extension-manifest.mjs           # write
 *   node tools/sync-extension-manifest.mjs --check   # verify, non-zero on drift
 *
 * The same arrangement as the firmware and planner snapshots: one hand-edited source, a
 * sync step, and a check wired into `npm run ci`. The point is that forgetting to set the
 * production origin becomes impossible rather than merely unlikely — `externally_connectable`
 * is fixed at extension build time, so shipping the placeholder means the extension cannot
 * talk to the dashboard at all and fixing it costs another Chrome Web Store review.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = resolve(here, '..', 'deployment.json');
const MANIFEST = resolve(here, '..', 'extension', 'manifest.json');

const PLACEHOLDER = 'CHANGE-ME';

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

/**
 * The ID Chrome gives an extension with this public key: the first 128 bits of the key's
 * SHA-256, written with the letters a–p for the hex digits 0–f. Checked rather than trusted,
 * because the ID and the key are pasted into deployment.json separately — from the Chrome Web
 * Store's Package tab — and a mismatch would break the helper for every user silently.
 */
function idFromKey(key) {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}

/**
 * The dashboard's account settings, as a generated module.
 *
 * Generated whole rather than patched, so what the app is built with is exactly what
 * deployment.json says, and a hand edit to the generated file shows up as drift.
 */
const ACCOUNT_MODULE = resolve(here, '..', 'app', 'src', 'lib', 'accountConfig.ts');
const PROVIDERS = ['google', 'github', 'microsoft'];
const FIREBASE_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];

function accountProblems() {
  const accounts = config.accounts ?? { firebase: null, signInProviders: [] };
  const problems = [];
  if (accounts.firebase !== null) {
    for (const key of FIREBASE_KEYS) {
      if (typeof accounts.firebase?.[key] !== 'string' || !accounts.firebase[key]) {
        problems.push(`accounts.firebase.${key} is missing. Paste the whole config object from the Firebase console.`);
      }
    }
  }
  const providers = accounts.signInProviders ?? [];
  for (const provider of providers) {
    if (!PROVIDERS.includes(provider)) problems.push(`accounts.signInProviders: "${provider}" is not one of ${PROVIDERS.join(', ')}.`);
  }
  if (accounts.firebase !== null && providers.length === 0) problems.push('accounts.signInProviders is empty, so nobody could sign in.');
  return problems;
}

function accountModule() {
  const accounts = config.accounts ?? { firebase: null, signInProviders: [] };
  const firebase = accounts.firebase
    ? Object.fromEntries(FIREBASE_KEYS.map((key) => [key, accounts.firebase[key]]))
    : null;
  return [
    '// Generated from deployment.json by tools/sync-extension-manifest.mjs. Do not edit;',
    '// change deployment.json and run `npm run sync:extension`.',
    '',
    "export type SignInProvider = 'google' | 'github' | 'microsoft';",
    '',
    'export interface FirebaseWebConfig {',
    '  apiKey: string;',
    '  authDomain: string;',
    '  projectId: string;',
    '  appId: string;',
    '}',
    '',
    '/** Null when this deployment offers no accounts. */',
    `export const FIREBASE_CONFIG: FirebaseWebConfig | null = ${JSON.stringify(firebase, null, 2)};`,
    '',
    `export const SIGN_IN_PROVIDERS: SignInProvider[] = ${JSON.stringify(accounts.signInProviders ?? [])};`,
    '',
  ].join('\n');
}

/**
 * Everywhere else the extension ID is written: the native helper will only answer an
 * extension it names, and the page only calls the one it names.
 */
const CONSUMERS = [
  { file: 'card-helper/internal/install/install.go', pattern: /(const ExtensionID = ")([a-p]{32})(")/ },
  { file: 'card-helper/packaging/linux/org.a3em.card_helper.json', pattern: /(chrome-extension:\/\/)([a-p]{32})(\/)/ },
  { file: 'app/src/lib/helper.ts', pattern: /(\?\?\s*')([a-p]{32})(';)/ },
];

/**
 * Origins the extension will answer.
 *
 * localhost and 127.0.0.1 are unconditional: they are what makes the dev server work, and
 * match patterns ignore ports, so one entry covers Vite on 5173 and anything else. See the
 * note in deployment.json about what that exposes and why it is acceptable.
 */
const matches = ['http://localhost/*', 'http://127.0.0.1/*'];
const placeholderOrigin = config.dashboardOrigin.includes(PLACEHOLDER);
if (!placeholderOrigin) matches.unshift(`${config.dashboardOrigin}/*`);

const expected = {
  ...manifest,
  key: config.extensionPublicKey,
  externally_connectable: { matches },
};

const check = process.argv.includes('--check');
const current = JSON.stringify(manifest, null, 2);
const wanted = JSON.stringify(expected, null, 2);

if (check) {
  let failed = false;

  if (current !== wanted) {
    console.error('✗ extension/manifest.json is out of step with deployment.json.');
    console.error('  Run: npm run sync:extension');
    failed = true;
  }

  const derived = idFromKey(config.extensionPublicKey);
  if (derived !== config.extensionId) {
    console.error(`✗ deployment.json's extensionId is not the ID of its extensionPublicKey, which is ${derived}.`);
    failed = true;
  }
  for (const problem of accountProblems()) {
    console.error(`✗ deployment.json: ${problem}`);
    failed = true;
  }
  let generated = '';
  try {
    generated = readFileSync(ACCOUNT_MODULE, 'utf8');
  } catch {
    // Reported below as drift.
  }
  if (generated !== accountModule()) {
    console.error('✗ app/src/lib/accountConfig.ts is out of step with deployment.json. Run: npm run sync:extension');
    failed = true;
  }
  for (const { file, pattern } of CONSUMERS) {
    const found = readFileSync(resolve(here, '..', file), 'utf8').match(pattern)?.[2];
    if (found !== config.extensionId) {
      console.error(`✗ ${file} names extension ${found ?? '(none found)'}, not ${config.extensionId}. Run: npm run sync:extension`);
      failed = true;
    }
  }

  if (placeholderOrigin) {
    console.error(
      `✗ deployment.json still has the placeholder dashboard origin.\n` +
        `  Set "dashboardOrigin" to where the dashboard is actually served, then run\n` +
        `  npm run sync:extension. The extension cannot reach the page until this is set,\n` +
        `  and externally_connectable is fixed at build time — changing it after the\n` +
        `  extension is published costs another Chrome Web Store review.`,
    );
    failed = true;
  }

  if (failed) process.exit(1);
  console.log(`✓ extension manifest matches deployment.json (${config.dashboardOrigin})`);
} else {
  const derived = idFromKey(config.extensionPublicKey);
  if (derived !== config.extensionId) {
    console.error(`✗ deployment.json's extensionId is not the ID of its extensionPublicKey, which is ${derived}.`);
    console.error('  Copy both from the same place: the Chrome Web Store Developer Dashboard, Package tab.');
    process.exit(1);
  }
  const problems = accountProblems();
  if (problems.length) {
    for (const problem of problems) console.error(`✗ deployment.json: ${problem}`);
    process.exit(1);
  }
  writeFileSync(MANIFEST, `${wanted}\n`, 'utf8');
  writeFileSync(ACCOUNT_MODULE, accountModule(), 'utf8');
  console.log(
    config.accounts?.firebase
      ? `Wrote app/src/lib/accountConfig.ts (Firebase project ${config.accounts.firebase.projectId}; ${config.accounts.signInProviders.join(', ')})`
      : 'Wrote app/src/lib/accountConfig.ts (no accounts: accounts.firebase is null)',
  );
  for (const { file, pattern } of CONSUMERS) {
    const path = resolve(here, '..', file);
    const text = readFileSync(path, 'utf8');
    if (!pattern.test(text)) {
      console.error(`✗ could not find the extension ID in ${file}`);
      process.exit(1);
    }
    writeFileSync(path, text.replace(pattern, `$1${config.extensionId}$3`), 'utf8');
    console.log(`Wrote the extension ID into ${file}`);
  }
  console.log(`Wrote extension/manifest.json`);
  console.log(`  origins:   ${matches.join(', ')}`);
  console.log(`  extension: ${config.extensionId}`);
  if (placeholderOrigin) {
    console.warn(
      `\n⚠ dashboardOrigin is still the placeholder, so only localhost is allowed.\n` +
        `  This is fine for development and will fail \`npm run ci\`.`,
    );
  }
}
