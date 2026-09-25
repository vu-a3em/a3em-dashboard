import { execFileSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The newest card helper released, from the repository's card-helper-v* tags, so the dashboard
 * can say when the one installed is older.
 *
 * Built in, rather than asked of GitHub by each visitor's browser: nothing leaves the browser
 * for it. The Pages workflow builds the dashboard again once a release is published, so it
 * knows of a release as soon as the release can be downloaded, and not before. Empty where
 * there are no tags to read, and then no update is ever announced. VITE_HELPER_RELEASE, set,
 * takes its place.
 */
function latestHelperRelease(): string {
  if (process.env.VITE_HELPER_RELEASE !== undefined) return process.env.VITE_HELPER_RELEASE;
  let tags = '';
  try {
    tags = execFileSync('git', ['tag', '--list', 'card-helper-v*'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
  const versions = tags
    .split('\n')
    .map((tag) => /^card-helper-v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match.slice(1).map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return versions.at(-1)?.join('.') ?? '';
}

/**
 * Warns when the main bundle grows past a budget.
 *
 * Vite's own warning applies one limit to every chunk, and the chunks loaded on demand are
 * large for good reason: the account database is about 600 kB and is fetched only after someone
 * signs in. Set low enough to catch the main bundle, it complained about Firebase on every build;
 * set high enough to spare Firebase, it would say nothing about the main bundle, which is the one
 * that matters. Everything in that bundle is downloaded before the dashboard appears.
 */
const MAIN_BUNDLE_BUDGET_KB = 500;

function mainBundleBudget(): Plugin {
  return {
    name: 'a3em-main-bundle-budget',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.isEntry) continue;
        const kb = new TextEncoder().encode(chunk.code).length / 1000;
        if (kb > MAIN_BUNDLE_BUDGET_KB) {
          this.warn(
            `The main bundle, ${chunk.fileName}, is ${kb.toFixed(0)} kB, over its ${MAIN_BUNDLE_BUDGET_KB} kB budget. ` +
              'All of it downloads before the dashboard appears. Move a feature that is not needed on first view ' +
              "behind a dynamic import(), as lib/useAccount.ts does with Firebase, or raise MAIN_BUNDLE_BUDGET_KB in " +
              'app/vite.config.ts if the growth is worth it.',
          );
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), mainBundleBudget()],
  define: {
    'import.meta.env.VITE_HELPER_RELEASE': JSON.stringify(latestHelperRelease()),
  },
  // Served from a subpath alongside the existing A3EM site; a relative base keeps the
  // build working wherever it is mounted.
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Above the chunks loaded on demand (Firestore, about 600 kB). The main bundle has its own,
    // tighter budget above.
    chunkSizeWarningLimit: 800,
  },
});
