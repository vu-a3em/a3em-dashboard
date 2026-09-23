#!/usr/bin/env node
/**
 * Builds the Go card helper and runs one of its commands, on any platform.
 *
 *   npm run helper:build                     → card-helper/dist/a3em-card-helper[.exe]
 *   npm run install-helper [-- --extension-id <id>]
 *   npm run helper-doctor
 *
 * A wrapper rather than a shell line because npm runs scripts in cmd.exe on Windows, which
 * neither finds a program by a forward-slash path nor adds `.exe` to it.
 *
 * For an installer instead, see card-helper/packaging and the card-helper-release workflow.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'card-helper');
const binary = join(root, 'dist', process.platform === 'win32' ? 'a3em-card-helper.exe' : 'a3em-card-helper');
const [command = 'build', ...args] = process.argv.slice(2);

function run(program, programArgs, cwd) {
  const result = spawnSync(program, programArgs, { cwd, stdio: 'inherit' });
  if (result.error) {
    console.error(program === 'go' ? 'The card helper is written in Go; install Go 1.22 or later from https://go.dev/dl/.' : String(result.error));
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('go', ['build', '-o', binary, './cmd/a3em-card-helper'], root);
if (command === 'build') {
  console.log(`✓ built ${binary}`);
} else {
  run(binary, [command, ...args]);
}
