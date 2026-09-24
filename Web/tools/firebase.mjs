#!/usr/bin/env node
/**
 * The Firebase command-line tool, pointed at this deployment's project.
 *
 *   npm run firebase -- login          once per computer: signs the CLI in with your Google account
 *   npm run deploy:rules               publishes firebase/firestore.rules to the project
 *   npm run firebase -- <anything>     any other firebase command, run in firebase/
 *
 * The project is the one named in deployment.json (accounts.firebase.projectId), so it never
 * has to be typed, and a pinned CLI version is fetched on first use rather than installed with
 * the dashboard: it is large, and only these commands need it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = 'firebase-tools@15.31.0';
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const deployment = JSON.parse(readFileSync(resolve(web, 'deployment.json'), 'utf8'));
const project = deployment.accounts?.firebase?.projectId ?? null;

const needsProject = !['login', 'logout', '--version', 'help'].includes(args[0] ?? '') && !args.includes('--project');
if (needsProject) {
  if (!project) {
    console.error('✗ deployment.json has no accounts.firebase yet. Paste the Firebase web app config there first.');
    process.exit(1);
  }
  args.push('--project', project);
}
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npx, ['--yes', CLI, ...args], { cwd: resolve(web, 'firebase'), stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
