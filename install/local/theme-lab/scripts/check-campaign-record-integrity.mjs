#!/usr/bin/env node
// Theme Lab campaign record integrity (ALLOC-32 R4 Check 1). Hard PASS/FAIL,
// never INCONCLUSIVE: a missing or unreadable record is a failure.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkCampaignRecordIntegrity} from '../src/campaign-record-integrity.mjs';

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
  const result = checkCampaignRecordIntegrity(root, {
    historicalRoot: option('--historical-root') ? path.resolve(option('--historical-root')) : undefined,
    storeRoot: option('--store-root') ?? undefined,
  });
  console.log(JSON.stringify({
    command: 'campaign-record-integrity',
    result: result.status === 'pass' ? 'CAMPAIGN RECORD INTACT' : 'CAMPAIGN RECORD NOT INTACT',
    overall_acceptance: {status: result.status},
    ...result,
  }, null, 2));
  process.exitCode = result.status === 'pass' ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({command: 'campaign-record-integrity', result: 'CAMPAIGN RECORD NOT INTACT', overall_acceptance: {status: 'fail'}, failures: [error.message]}, null, 2));
  process.exitCode = 1;
}
