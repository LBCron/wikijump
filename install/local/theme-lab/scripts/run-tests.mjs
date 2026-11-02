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
//
// Each test file runs as its own `node --test` process, and this parent
// verifies the count that process reports for itself before it trusts
// the run. The previous shape — one aggregate `node --test` invocation
// over all files — silently lost results under CPU load: the aggregate's
// reporter counted only the per-file events it had processed when
// `--test-force-exit` ended the process, so a contention-lagged file's
// trailing tests vanished from the summary while the exit code stayed 0
// (reproduced synthetically and observed in real runs: 850 of 866 tests
// reported, check green; see muse-bhl/theme-lab-perf-20261102/
// step4-concurrency.md and undercount-audit.md). A short aggregate could
// therefore pass without proving what it covered. Here every file's own
// summary is computed inside that file's process
// (`--test-isolation=none`: no inter-process event hop between a test
// finishing and its count), written to a file descriptor rather than a
// pipe, and checked by name: a file whose summary is missing, or whose
// process failed, fails the whole run with the file named.
//
// `--test-force-exit` stays, on each file process: a test file whose
// process outlives its tests (for example a leaked browser) otherwise
// blocks the whole run with no timeout; `--test-timeout` only bounds
// individual tests. Splitting force-exit off the parent is not
// available in a single aggregate invocation (the flag is inherited by
// the per-file children, and dropping it reintroduces the hang), so the
// split is structural instead: the force-exit lives in the children and
// the parent — this file — never force-exits; it finishes its
// bookkeeping and reports what it verified.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
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

const SUMMARY_PATTERN = /ℹ tests (\d+)\nℹ suites (\d+)\nℹ pass (\d+)\nℹ fail (\d+)\nℹ cancelled (\d+)\nℹ skipped (\d+)\nℹ todo (\d+)\nℹ duration_ms ([\d.]+)/;

/**
 * The one summary block a `node --test` spec run prints, with the counts
 * that process computed for itself. Returns null when the block is
 * absent or truncated — the reporting-loss signature this runner exists
 * to catch.
 */
export function extractTestSummary(output) {
  const match = SUMMARY_PATTERN.exec(output);
  if (!match) return null;
  return {
    counts: {
      tests: Number(match[1]),
      suites: Number(match[2]),
      pass: Number(match[3]),
      fail: Number(match[4]),
      cancelled: Number(match[5]),
      skipped: Number(match[6]),
      todo: Number(match[7]),
    },
    durationMs: Number(match[8]),
    index: match.index,
    length: match[0].length,
  };
}

/** A file's output with its own summary block removed (the parent prints one aggregate block). */
export function stripTestSummary(output, summary) {
  return output.slice(0, summary.index) + output.slice(summary.index + summary.length);
}

/**
 * Split off a file's trailing "✖ failing tests:" detail section. The
 * aggregate reporter prints every file's detail sections after the one
 * summary block; the parent does the same, so the combined output
 * keeps the shape log parsers already expect.
 */
export function splitFailingSection(output) {
  const marker = '\n✖ failing tests:\n';
  const index = output.indexOf(marker);
  if (index === -1) return {body: output, failing: ''};
  return {body: output.slice(0, index + 1), failing: output.slice(index + 1)};
}

const EMPTY_COUNTS = Object.freeze({tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0});

/**
 * Sum the per-file counts and name every file whose result cannot be
 * trusted: killed by a signal, exited non-zero, reported failures while
 * exiting 0, or produced no summary at all. A problem is a failed run,
 * never a footnote.
 */
export function assessFileResults(results) {
  const totals = {...EMPTY_COUNTS};
  const problems = [];
  for (const result of results) {
    if (result.summary) {
      for (const key of Object.keys(EMPTY_COUNTS)) totals[key] += result.summary.counts[key];
    }
    if (result.signal) {
      problems.push({file: result.file, reason: `killed by signal ${result.signal}`});
    } else if (result.status !== 0) {
      const detail = result.summary && result.summary.counts.fail > 0 ? `, ${result.summary.counts.fail} failing test(s) reported` : '';
      problems.push({file: result.file, reason: `exited ${result.status}${detail}`});
    } else if (!result.summary) {
      problems.push({file: result.file, reason: 'no test summary in its output; its results cannot be verified'});
    } else if (result.summary.counts.fail > 0) {
      problems.push({file: result.file, reason: `reported ${result.summary.counts.fail} failing test(s) but exited 0`});
    }
  }
  return {totals, problems};
}

function runOneFile(file, {root, tmpDir, index, spawnImpl}) {
  const stdoutPath = path.join(tmpDir, `${index}.stdout`);
  const stderrPath = path.join(tmpDir, `${index}.stderr`);
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      process.execPath,
      ['--test', '--test-isolation=none', '--test-timeout=240000', '--test-force-exit', file],
      {cwd: root, env: process.env, stdio: ['ignore', stdoutFd, stderrFd]},
    );
    child.on('error', reject);
    child.on('close', (status, signal) => {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
      resolve({
        file,
        status,
        signal,
        stdout: fs.readFileSync(stdoutPath, 'utf8'),
        stderr: fs.readFileSync(stderrPath, 'utf8'),
      });
    });
  });
}

/**
 * Run every file as its own test process (at most `concurrency` at
 * once), stream each file's output as it finishes, then print one
 * aggregate summary built from the per-file summaries. Returns 0 only
 * when every file's own count was seen and every file passed.
 */
export async function runSuite(files, {
  root = themeLabRoot,
  concurrency = 4,
  spawnImpl = spawn,
  out = process.stdout,
  err = process.stderr,
} = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-lab-run-tests-'));
  const started = Date.now();
  try {
    const results = new Array(files.length);
    const failingSections = new Array(files.length).fill('');
    let cursor = 0;
    const worker = async () => {
      while (cursor < files.length) {
        const index = cursor;
        cursor += 1;
        const raw = await runOneFile(files[index], {root, tmpDir, index, spawnImpl});
        const summary = extractTestSummary(raw.stdout);
        results[index] = {file: raw.file, status: raw.status, signal: raw.signal, summary};
        const stripped = summary ? stripTestSummary(raw.stdout, summary) : raw.stdout;
        const {body, failing} = splitFailingSection(stripped);
        failingSections[index] = failing;
        out.write(body);
        if (raw.stderr) err.write(raw.stderr);
      }
    };
    await Promise.all(Array.from({length: Math.min(concurrency, files.length)}, () => worker()));
    const {totals, problems} = assessFileResults(results);
    out.write(
      `ℹ tests ${totals.tests}\n` +
      `ℹ suites ${totals.suites}\n` +
      `ℹ pass ${totals.pass}\n` +
      `ℹ fail ${totals.fail}\n` +
      `ℹ cancelled ${totals.cancelled}\n` +
      `ℹ skipped ${totals.skipped}\n` +
      `ℹ todo ${totals.todo}\n` +
      `ℹ duration_ms ${Date.now() - started}\n`,
    );
    for (const section of failingSections) if (section) out.write(`\n${section}`);
    if (problems.length > 0) {
      err.write(`theme-lab tests: ${problems.length} file(s) failed or could not be verified:\n`);
      for (const problem of problems) err.write(`theme-lab tests: ${problem.file}: ${problem.reason}\n`);
      return 1;
    }
    err.write(`theme-lab tests: verified per-file test counts for ${files.length} files: ${totals.tests} tests\n`);
    return 0;
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
}

export async function main(argv = process.argv.slice(2)) {
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
  const rawConcurrency = process.env.THEME_LAB_TEST_CONCURRENCY ?? '4';
  const concurrency = Number(rawConcurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`THEME_LAB_TEST_CONCURRENCY must be a positive integer, got ${JSON.stringify(rawConcurrency)}`);
  }
  process.exitCode = await runSuite(files, {concurrency});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack ?? error?.message ?? String(error));
    process.exitCode = 1;
  });
}
