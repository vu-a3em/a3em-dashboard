#!/usr/bin/env node
/**
 * Runs the card integrity check over a directory, outside the browser.
 *
 *   node tools/check-card.mjs /Volumes/A3EM [--legacy|--modern]
 *
 * Same `judgeWavFile`/`judgeImuFile` the app uses, so what this prints is exactly what
 * the app would show. Useful for a mounted card image, a copied folder, or anywhere the
 * File System Access API is not available.
 *
 * On macOS a card image mounts read-only with:
 *   hdiutil attach -readonly /path/to/card.img
 * and detaches with `hdiutil detach /Volumes/<name>`. Read-only matters — a damaged
 * filesystem is exactly the case where the OS may decide to "helpfully" repair it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { judgeImuFile, judgeWavFile } from '../packages/config-schema/dist/integrity.js';
import { DEVICE_INFO_FILE_NAME } from '../packages/config-schema/dist/device-info.js';

const WAV_HEADER_BYTES = 44;

const args = process.argv.slice(2);
const root = args.find((arg) => !arg.startsWith('--'));
if (!root) {
  console.error('usage: node tools/check-card.mjs <card-directory> [--legacy|--modern]');
  process.exit(2);
}

// Same rule the app applies: the current firmware writes _a3em.dev on every boot, so a
// card without one was written by the legacy firmware. Overridable for a card whose root
// file was lost along with everything else.
const hasDeviceInfo = fs.existsSync(path.join(root, DEVICE_INFO_FILE_NAME));
const correctWavChunkSize = args.includes('--modern')
  ? true
  : args.includes('--legacy')
    ? false
    : hasDeviceInfo;

const files = [];
const unreadable = [];
// A quarter-million-file card takes minutes to walk. Reporting as it goes is the
// difference between "working" and "hung" from the outside.
const note = (message) => process.stderr.write(`\r${message.padEnd(78)}`);
(function walk(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    // A directory that cannot be listed is itself a finding on a damaged card.
    unreadable.push({ path: directory, reason: error.message });
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      files.push(full);
      if (files.length % 5000 === 0) note(`  scanning... ${files.length.toLocaleString()} files found`);
    }
  }
})(root);

const tally = {};
const examples = new Map();
const repairable = [];
let totalBytes = 0;

let examined = 0;
for (const file of files) {
  if (++examined % 2000 === 0) {
    note(`  checking... ${examined.toLocaleString()} of ${files.length.toLocaleString()} (${((examined / files.length) * 100).toFixed(1)}%)`);
  }
  let size;
  try {
    size = fs.statSync(file).size;
  } catch (error) {
    unreadable.push({ path: file, reason: error.message });
    continue;
  }
  totalBytes += size;

  const lower = file.toLowerCase();
  let judgment;
  if (lower.endsWith('.imu')) {
    judgment = judgeImuFile(size);
  } else if (lower.endsWith('.wav')) {
    let header = null;
    if (size > 0) {
      try {
        const fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(WAV_HEADER_BYTES);
        const read = fs.readSync(fd, buffer, 0, WAV_HEADER_BYTES, 0);
        fs.closeSync(fd);
        header = new Uint8Array(buffer.subarray(0, read));
      } catch (error) {
        // A read failure here is the real thing this tool exists to find.
        unreadable.push({ path: file, reason: error.message });
        continue;
      }
    }
    judgment = judgeWavFile(size, header, { correctWavChunkSize });
  } else {
    continue;
  }

  tally[judgment.verdict] = (tally[judgment.verdict] ?? 0) + 1;
  if (judgment.verdict !== 'ok' && !examples.has(judgment.verdict)) {
    examples.set(judgment.verdict, { file: path.relative(root, file), detail: judgment.detail });
  }
  if (judgment.repair) repairable.push({ path: path.relative(root, file), repair: judgment.repair });
}

note('');
process.stderr.write('\r');
const recordings = Object.values(tally).reduce((sum, count) => sum + count, 0);
console.log(`\nCard:      ${root}`);
console.log(`Firmware:  ${correctWavChunkSize ? 'current' : 'legacy'}` +
  `${hasDeviceInfo ? '' : `  — no ${DEVICE_INFO_FILE_NAME} at the root`}`);
console.log(`Files:     ${files.length.toLocaleString()} total, ${recordings.toLocaleString()} recordings, ` +
  `${(totalBytes / 1024 ** 3).toFixed(2)} GB\n`);

for (const [verdict, count] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  const share = ((count / recordings) * 100).toFixed(1);
  console.log(`  ${verdict.padEnd(12)} ${String(count).padStart(7)}  ${share.padStart(5)}%`);
  const example = examples.get(verdict);
  if (example) console.log(`  ${''.padEnd(12)} e.g. ${example.file}\n  ${''.padEnd(12)}      ${example.detail}`);
}

if (repairable.length) {
  console.log(`\n${repairable.length.toLocaleString()} recordings can be repaired by rewriting their headers.`);
  for (const target of repairable.slice(0, 10)) {
    console.log(`  ${target.path}  ->  data ${target.repair.dataSize.toLocaleString()}, riff ${target.repair.riffSize.toLocaleString()}`);
  }
  if (repairable.length > 10) console.log(`  ... and ${repairable.length - 10} more`);
}

if (unreadable.length) {
  console.log(`\n${unreadable.length.toLocaleString()} items could not be read at all:`);
  for (const item of unreadable.slice(0, 20)) {
    console.log(`  ${path.relative(root, item.path)}: ${item.reason}`);
  }
  if (unreadable.length > 20) console.log(`  ... and ${unreadable.length - 20} more`);
}

console.log('');
