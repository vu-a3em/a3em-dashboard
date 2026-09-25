#!/usr/bin/env node
/**
 * Releases a new version of the card helper.
 *
 *   npm run release:helper              next patch version: 0.2.0 → 0.2.1
 *   npm run release:helper -- minor     0.2.0 → 0.3.0
 *   npm run release:helper -- major     0.2.0 → 1.0.0
 *   npm run release:helper -- 0.4.2     exactly this
 *
 * The version lives nowhere but the tag. This checks the release is of what is on GitHub's
 * main — committed, pushed, nothing left over — and that the Card helper workflow has passed on
 * GitHub for the helper's code as it is now; then tags that commit `card-helper-v<version>`, and
 * pushes the tag, which starts the release workflow: the signed installers, then the GitHub
 * release. The tests are not run again there, since that is what this has just confirmed. It
 * asks before tagging. `-- --without-ci-check` skips the check, for when GitHub cannot be asked.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', cwd: web }).trim();
const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const parse = (text) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return match ? match.slice(1).map(Number) : null;
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

git('fetch', '--quiet', '--tags', 'origin');
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('Release from main.');
if (git('status', '--porcelain')) fail('There are uncommitted changes. Commit or set them aside first.');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
  fail('This main is not the same as GitHub’s. Push (or pull) first, so the release is of what is on GitHub.');
}

const released = git('tag', '--list', 'card-helper-v*')
  .split('\n')
  .map((tag) => parse(tag.replace('card-helper-v', '')))
  .filter(Boolean)
  .sort(compare);
const latest = released.at(-1) ?? null;

/*
  The Card helper workflow has passed for the helper's code as it is now: on this commit, or an
  earlier one on main whose code is the same — a commit that changed only the dashboard, or only
  the helper's notes, which that workflow does not run for, releases code it has already tested.
*/
const REPOSITORY = 'vu-a3em/a3em-dashboard';
const code = (commit) => {
  try {
    return git('ls-tree', '-r', commit, '--', 'card-helper')
      .split('\n')
      .filter((line) => !/\.md$/.test(line) && !line.includes('/test/e2e/'))
      .join('\n');
  } catch {
    return null; // a commit not fetched here
  }
};
if (!process.argv.includes('--without-ci-check')) {
  const now = code('HEAD');
  let runs;
  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/actions/workflows/card-helper.yml/runs?branch=main&per_page=50`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    runs = (await response.json()).workflow_runs ?? [];
  } catch (error) {
    fail(`Could not ask GitHub whether the helper's tests passed (${error.message}). Try again, or pass --without-ci-check.`);
  }
  const tested = runs.filter((run) => code(run.head_sha) === now);
  const passed = tested.find((run) => run.conclusion === 'success');
  if (!passed) {
    const running = tested.find((run) => run.status !== 'completed');
    const failed = tested.find((run) => run.status === 'completed');
    fail(
      running
        ? `The Card helper workflow is still testing this code: ${running.html_url}. Release once it has passed.`
        : failed
          ? `The Card helper workflow did not pass for this code (${failed.conclusion}): ${failed.html_url}. Fix it first.`
          : 'The Card helper workflow has not tested this code on main yet. Push it, and release once it has passed.',
    );
  }
  console.log(`✓ The Card helper workflow passed for this code: ${passed.html_url}`);
}

const request = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'patch';
let next;
if (parse(request)) {
  next = parse(request);
} else if (!latest) {
  fail('There is no earlier release to count from. Give the version: npm run release:helper -- 0.2.0');
} else if (request === 'patch') {
  next = [latest[0], latest[1], latest[2] + 1];
} else if (request === 'minor') {
  next = [latest[0], latest[1] + 1, 0];
} else if (request === 'major') {
  next = [latest[0] + 1, 0, 0];
} else {
  fail(`"${request}" is not patch, minor, major, or a version like 0.2.1.`);
}
if (latest && compare(next, latest) <= 0) fail(`${next.join('.')} is not after the latest release, ${latest.join('.')}.`);

const version = next.join('.');
const tag = `card-helper-v${version}`;
const since = latest ? git('log', '--oneline', `card-helper-v${latest.join('.')}..HEAD`, '--', 'card-helper', '../.github/workflows/card-helper-release.yml') : '';
console.log(`Release card helper ${version}${latest ? ` (after ${latest.join('.')})` : ''} from ${git('log', '-1', '--format=%h %s')}`);
console.log(since ? `Changes to the helper since then:\n${since.replace(/^/gm, '  ')}` : latest ? 'Nothing in card-helper/ has changed since the last release.' : '');

const answer = await createInterface({ input: process.stdin, output: process.stdout }).question(`Tag ${tag} and push it? [y/N] `);
if (!/^y(es)?$/i.test(answer.trim())) {
  console.log('Nothing was tagged.');
  process.exit(0);
}
git('tag', '-a', tag, '-m', `A3EM card helper ${version}`);
git('push', 'origin', tag);
console.log(`✓ Pushed ${tag}. The release builds at https://github.com/vu-a3em/a3em-dashboard/actions/workflows/card-helper-release.yml`);
process.exit(0);
