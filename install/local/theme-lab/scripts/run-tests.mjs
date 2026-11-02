#!/usr/bin/env node
// Theme Lab test entry point (package.json "test").
//
// Several suites (browser interaction, capture CLI) resolve
// `@playwright/test` through framerail's node_modules via createRequire,
// because framerail owns the Playwright dependency. In a clean checkout
// where the framerail group has not run, that resolution fails and the
// tests die with "Cannot find module '@playwright/test'" — an install
// state problem, not a test result (#2777). Ensure framerail's
// dependencies are installed (frozen lockfile; a warm pnpm store makes
// this a few seconds and needs no network) before running the suite, so
// every caller — preflight, consolidated validation, a manual npm test —
// exercises the same tests.

import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const themeLabRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(themeLabRoot, '../../..');
export const framerailRoot = path.join(repoRoot, 'framerail');

/** True when `@playwright/test` cannot be resolved from framerail. */
export function framerailPlaywrightMissing(root = framerailRoot) {
  return !fs.existsSync(path.join(root, 'node_modules', '@playwright', 'test', 'package.json'));
}

/** The suite's test files, in the shell-glob order the old script used. */
export function collectTestFiles(args, root = themeLabRoot) {
  if (args.length > 0) return args;
  return fs.readdirSync(path.join(root, 'tests'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.join('tests', name));
}

export function ensureFramerailDependencies(root = framerailRoot, run = spawnSync) {
  if (!framerailPlaywrightMissing(root)) return false;
  process.stderr.write('theme-lab tests: framerail dependencies missing; running pnpm install --frozen-lockfile\n');
  const result = run('pnpm', ['install', '--frozen-lockfile'], {cwd: root, stdio: 'inherit'});
  if (result.error) throw new Error(`could not run pnpm install in framerail: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`pnpm install in framerail exited ${result.status}`);
  if (framerailPlaywrightMissing(root)) {
    throw new Error('framerail dependencies installed but @playwright/test is still unresolvable');
  }
  return true;
}

export function main(argv = process.argv.slice(2)) {
  ensureFramerailDependencies();
  const files = collectTestFiles(argv);
  // File-level parallelism for the suite. The default stays at 4
  // (owner decision, 2026-10-31): a higher default was measured faster
  // solo (65-76 s at 8 against 100 s at 4 on the 16-core WSL host) but
  // is not an accepted way to buy speed — in full validation runs the
  // extra files only contend with the sibling groups, and the suite
  // carries the wall-clock-deadline tests the wave structure protects.
  // Suite speed comes from removing wasted work, not from widening
  // this knob. THEME_LAB_TEST_CONCURRENCY still overrides it for
  // experiments.
  // Scoped exception (2026-11-02, delegated authority: the Theme Lab
  // performance consult; step-4 evidence step4-concurrency.md in the
  // campaign record): scripts/preflight.sh passes
  // THEME_LAB_TEST_CONCURRENCY=6 when theme_lab is the only selected
  // validation group, the archive checks are not selected, and the
  // variable is otherwise unset — the forced theme_lab-only rerun,
  // whose interleaved group-wall median measured 52.5 s at 6 against
  // 69.0 s at 4 (n=20 each). That partly reverses the 2026-10-31
  // decision above for that one run shape only: this default stays 4,
  // the full gate and CI stay at 4 (CI pins the variable), promotion
  // stays at 4 (it forces the archive checks), and an explicit
  // THEME_LAB_TEST_CONCURRENCY always wins. The value arrives through
  // the environment, exactly like an experimenter's, and preflight
  // prints the effective value in the log the validation receipt
  // hashes, so the exception is never silent.
  // --test-force-exit: a test file whose process outlives its tests (for
  // example a leaked browser) otherwise blocks the whole run with no timeout;
  // --test-timeout only bounds individual tests.
  const concurrency = process.env.THEME_LAB_TEST_CONCURRENCY ?? '4';
  const result = spawnSync(
    process.execPath,
    ['--test', `--test-concurrency=${concurrency}`, '--test-timeout=240000', '--test-force-exit', ...files],
    {cwd: themeLabRoot, stdio: 'inherit'},
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
