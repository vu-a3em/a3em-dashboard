#!/usr/bin/env node
/**
 * Packages the extension for the Chrome Web Store.
 *
 *   npm run package:extension   → dist/a3em-card-helper-extension-<version>.zip
 *
 * The zip holds only what the extension runs: the manifest, the service worker, and its icons.
 * The manifest's `key` is left out. The store holds the key for a published item and does not
 * accept one in an upload; the copy in the repository exists only so that an unpacked
 * extension, loaded for development, has the same ID as the published one.
 *
 * Nothing here can be skipped by accident: it refuses to package a manifest that is out of step
 * with deployment.json, since the published extension could then not reach the dashboard.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const extension = join(root, 'extension');

execFileSync(process.execPath, [join(here, 'sync-extension-manifest.mjs'), '--check'], { stdio: 'inherit' });

const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
delete manifest.key;
const files = [
  ['manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
  ['background.js', readFileSync(join(extension, 'background.js'))],
  ...Object.values(manifest.icons).map((path) => [path, readFileSync(join(extension, path))]),
];

// A minimal zip writer: deflated entries, one central directory, no extras.
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (data) => {
  let c = 0xffffffff;
  for (const byte of data) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const local = [];
const central = [];
let offset = 0;
for (const [name, data] of files) {
  const packed = deflateRawSync(data, { level: 9 });
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(packed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  local.push(header, nameBytes, packed);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt32LE(crc32(data), 16);
  entry.writeUInt32LE(packed.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(nameBytes.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, nameBytes);
  offset += header.length + nameBytes.length + packed.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', `a3em-card-helper-extension-${manifest.version}.zip`);
writeFileSync(out, Buffer.concat([...local, directory, end]));
console.log(`✓ ${out}`);
for (const [name, data] of files) console.log(`    ${name} (${data.length} bytes)`);
