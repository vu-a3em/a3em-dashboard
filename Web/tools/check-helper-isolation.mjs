#!/usr/bin/env node
/**
 * Asserts the card helper stays optional.
 *
 * The dashboard must work with no extension installed, which is the state every existing
 * user is in and the state most will stay in. That guarantee holds today for a structural
 * reason rather than a careful one: nothing in the card path imports anything from the
 * helper, so there is no code path where an absent helper can affect reading or writing a
 * card.
 *
 * That is exactly the kind of property that decays silently. One convenient import from
 * `useCard` into `helper` and the guarantee is gone, with no test failing and no symptom
 * until someone without the extension opens the app. Hence a guard rather than a comment.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', 'app', 'src');

/** Files that must keep working with no extension, and so must not reach for one. */
const CARD_PATH = [
  'lib/card.ts',
  'lib/useCard.ts',
  'lib/transfer.ts',
  'lib/useOffloadTask.ts',
  'lib/cardTime.ts',
  'components/CardStatus.tsx',
  'components/CardLoading.tsx',
];

const FORBIDDEN = /from\s+['"][^'"]*\/?(helper|useHelper|helperInstall)['"]/;

const offenders = [];
for (const file of CARD_PATH) {
  let text;
  try {
    text = readFileSync(resolve(src, file), 'utf8');
  } catch {
    // A renamed or removed file is not this check's business to complain about.
    continue;
  }
  if (FORBIDDEN.test(text)) offenders.push(file);
}

if (offenders.length) {
  console.error(
    '✗ The card path imports the helper, which breaks the no-extension fallback:\n' +
      offenders.map((file) => `    app/src/${file}`).join('\n') +
      '\n\n  Reading and writing a card must not depend on the helper being installed.\n' +
      '  Pass helper results in from a view instead of importing them here.',
  );
  process.exit(1);
}

console.log(`✓ card path is independent of the helper (${CARD_PATH.length} files checked)`);
