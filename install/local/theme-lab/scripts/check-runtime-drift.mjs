#!/usr/bin/env node
// Theme Lab runtime drift report (ALLOC-32 R4 Check 3). Reporting only:
// exit 0 whenever the report computes, 1 when it cannot compute (a broken
// reporter would hide drift).
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildRuntimeDriftReport} from '../src/runtime-drift-report.mjs';

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a path`);
  return value;
};
try {
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = option('--root') ? path.resolve(option('--root')) : here;
  const report = buildRuntimeDriftReport(root, {
    historicalRoot: option('--historical-root') ? path.resolve(option('--historical-root')) : undefined,
  });
  console.log(JSON.stringify({command: 'runtime-drift-report', result: 'DRIFT REPORTED', ...report}, null, 2));
  process.exitCode = 0;
} catch (error) {
  console.log(JSON.stringify({command: 'runtime-drift-report', result: 'DRIFT REPORT UNAVAILABLE', failures: [error.message]}, null, 2));
  process.exitCode = 1;
}
