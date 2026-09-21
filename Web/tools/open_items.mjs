#!/usr/bin/env node
/**
 * Prints the open-items registry as a checklist.
 *
 *   node tools/open_items.mjs            # unresolved only
 *   node tools/open_items.mjs --all      # including resolved
 *   node tools/open_items.mjs --area power
 *   node tools/open_items.mjs --markdown # for pasting into a doc or issue
 *
 * Reads the compiled package, so run `npm run build` in packages/config-schema first
 * (`npm run open-items` does both).
 */

import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = resolve(HERE, '../packages/config-schema/dist/open-items.js');

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const asMarkdown = args.includes('--markdown');
const areaFlag = args.indexOf('--area');
const area = areaFlag >= 0 ? args[areaFlag + 1] : null;

let registry;
try {
  registry = await import(pathToFileURL(MODULE).href);
} catch {
  console.error(
    `Could not load ${MODULE}\n` + 'Build the package first:  npm --prefix packages/config-schema run build',
  );
  process.exit(1);
}

const STATUS = {
  blocked: { icon: '●', label: 'BLOCKED', rank: 0 },
  placeholder: { icon: '○', label: 'PLACEHOLDER', rank: 1 },
  assumed: { icon: '◌', label: 'ASSUMED', rank: 2 },
  resolved: { icon: '✓', label: 'RESOLVED', rank: 3 },
};

let items = showAll ? registry.OPEN_ITEMS : registry.unresolvedItems();
if (area) items = items.filter((item) => item.area === area);
items = [...items].sort(
  (a, b) => STATUS[a.status].rank - STATUS[b.status].rank || a.id.localeCompare(b.id),
);

if (items.length === 0) {
  console.log(area ? `No open items in area "${area}".` : 'No open items.');
  process.exit(0);
}

const counts = items.reduce((acc, item) => {
  acc[item.status] = (acc[item.status] ?? 0) + 1;
  return acc;
}, {});

if (asMarkdown) {
  console.log('# A3EM open items\n');
  console.log(
    Object.entries(counts)
      .map(([status, n]) => `**${n}** ${status}`)
      .join(' · ') + '\n',
  );
  for (const item of items) {
    console.log(`## ${STATUS[item.status].label} — ${item.title}`);
    console.log(`\`${item.id}\` · area: ${item.area}\n`);
    console.log(`**Currently:** ${item.currentBehavior}\n`);
    console.log(`**Blocks:** ${item.blocks}\n`);
    console.log(`**Needed:** ${item.needed}\n`);
    if (item.measurementKeys?.length) {
      console.log(`**Covers:** ${item.measurementKeys.map((k) => `\`${k}\``).join(', ')}\n`);
    }
    if (item.resolvedNote) console.log(`**Resolved:** ${item.resolvedNote}\n`);
  }
} else {
  const summary = Object.entries(counts)
    .map(([status, n]) => `${n} ${status}`)
    .join(', ');
  console.log(`\nA3EM open items — ${summary}\n`);
  let lastArea = null;
  for (const item of items) {
    if (item.area !== lastArea) {
      console.log(`\n${item.area.toUpperCase()}`);
      lastArea = item.area;
    }
    const { icon, label } = STATUS[item.status];
    console.log(`\n  ${icon} [${label}] ${item.title}`);
    console.log(`      id      ${item.id}`);
    console.log(`      now     ${wrap(item.currentBehavior)}`);
    console.log(`      blocks  ${wrap(item.blocks)}`);
    console.log(`      needed  ${wrap(item.needed)}`);
    if (item.resolvedNote) console.log(`      done    ${wrap(item.resolvedNote)}`);
  }
  console.log('');
}

function wrap(text, width = 76, indent = ' '.repeat(14)) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n' + indent);
}
