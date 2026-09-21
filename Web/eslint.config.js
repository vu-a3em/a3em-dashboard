import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Lint rules, chosen for one purpose: catching bugs the compiler cannot see.
 *
 * This exists because of a real one. A `useMemo` placed below a component's early return
 * ran only on some renders, so finishing a card scan changed the hook count mid-life and
 * React unmounted the page to a blank screen — a fault with no type error, no failing
 * test, and a reproduction that depended on which tab you started from.
 * `react-hooks/rules-of-hooks` reports it as an error on the line that causes it.
 *
 * Deliberately not a style guide. Nothing here reformats code, orders imports or has an
 * opinion about naming; `npm run ci` has to stay a signal that something is wrong, and a
 * check that cries wolf about spacing is one people learn to run with their eyes shut.
 */
export default tseslint.config(
  {
    // Build output, dependencies, and the extension's vendored bundle.
    ignores: ['**/dist/**', '**/node_modules/**', 'extension/**', 'app/public/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      /*
        An unused value is usually a leftover from an edit that did not finish — a
        destructured field nobody reads, a parameter whose argument moved. Names starting
        with `_` are exempt so a signature can keep a position it must accept but ignore.
      */
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      /*
        `catch {}` with no body is used throughout for genuinely optional work — reading
        localStorage, probing for a capability — and each one carries a comment saying so.
        Empty blocks elsewhere are still worth reporting.
      */
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Assigning inside a condition is nearly always a mistyped comparison.
      'no-cond-assign': ['error', 'always'],
      // `case` falling into the next one silently, without an explicit comment.
      'no-fallthrough': 'error',
    },
  },
  {
    // The React rules only mean anything where components live.
    files: ['app/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      /*
        A warning, not an error. A dependency array that omits something is sometimes the
        point — an effect meant to run on one signal and read the rest as it finds them —
        so this is advice worth reading rather than a gate on the build.
      */
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
