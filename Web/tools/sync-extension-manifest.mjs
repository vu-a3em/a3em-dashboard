#!/usr/bin/env node
/**
 * Writes `deployment.json` into the extension manifest, and checks it has not drifted.
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
  writeFileSync(MANIFEST, `${wanted}\n`, 'utf8');
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
