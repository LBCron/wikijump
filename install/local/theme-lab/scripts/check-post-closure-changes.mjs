#!/usr/bin/env node
// Theme Lab post-closure changes (ALLOC-32 R4 Check 2). FATAL. --base
// <commit> is required; the validation runner supplies its receipt's
// base_commit. Missing base fails. Packages outside the change-set whose
// candidate is unadmitted are listed in pending_admission without failing.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkPostClosureAcceptance} from '../src/post-closure-acceptance.mjs';

const args = process.argv.slice(2);
const option = name => {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
      return value;
    }
    if (args[index].startsWith(`${name}=`)) return args[index].slice(name.length + 1);
  }
  return undefined;
};
try {
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = option('--root') ? path.resolve(option('--root')) : here;
  const result = checkPostClosureAcceptance(root, {
    base: option('--base') ?? null,
    historicalRoot: option('--historical-root') ? path.resolve(option('--historical-root')) : undefined,
  });
  console.log(JSON.stringify({
    command: 'post-closure-changes',
    result: result.status === 'pass' ? 'POST-CLOSURE CHANGES ACCEPTED' : 'POST-CLOSURE CHANGES NOT ACCEPTED',
    overall_acceptance: {status: result.status},
    ...result,
  }, null, 2));
  process.exitCode = result.status === 'pass' ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({command: 'post-closure-changes', result: 'POST-CLOSURE CHANGES NOT ACCEPTED', overall_acceptance: {status: 'fail'}, packages: [], pending_admission: [], failures: [error.message]}, null, 2));
  process.exitCode = 1;
}
