#!/usr/bin/env node
// Derives the authority restore inventory from the checkout's tracked
// adaptation ledger and the content-addressed store. The inventory is a
// disposable build product: nothing about it is committed or hand-pinned.
//
//   derive-authority-inventory.mjs --store <dir> [--checkout <repo root>] --output <file>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {deriveAuthorityInventory, MissingAuthorityBlobs} from '../src/authority-evidence-closure.mjs';

const defaultCheckout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function parseArguments(argv) {
  const options = {checkout: defaultCheckout};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!['--store', '--checkout', '--output'].includes(key) || !value) throw new Error(`usage: derive-authority-inventory.mjs --store <dir> [--checkout <repo root>] --output <file>`);
    options[key.slice(2)] = path.resolve(value);
  }
  if (!options.store || !options.output) throw new Error('--store and --output are required');
  return options;
}

const regularFile = file => {
  try { const info = fs.lstatSync(file); return info.isFile() ? info : null; } catch { return null; }
};

export function blobReaders({store, checkout}) {
  const blob = hash => path.join(store, 'objects', hash.slice(0, 2), hash);
  // A file in the checkout wins when it matches, so an author can derive an
  // inventory for evidence they have not ingested into the store yet.
  const readBlob = (relative, hash) => {
    if (regularFile(path.join(checkout, relative))) {
      const bytes = fs.readFileSync(path.join(checkout, relative));
      if (sha256(bytes) === hash) return bytes;
    }
    if (regularFile(blob(hash))) {
      const bytes = fs.readFileSync(blob(hash));
      if (sha256(bytes) !== hash) throw new Error(`stored blob does not match its name: ${blob(hash)}`);
      return bytes;
    }
    return null;
  };
  // Stored blobs are addressed by hash, so their size is enough here; the
  // restore step re-hashes every object it installs.
  const statBlob = (relative, hash) => {
    const stored = regularFile(blob(hash));
    if (stored) return stored.size;
    return regularFile(path.join(checkout, relative)) ? readBlob(relative, hash)?.length ?? null : null;
  };
  return {readBlob, statBlob};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const portsRoot = path.join(options.checkout, 'install/local/theme-lab/ports');
    const inventory = deriveAuthorityInventory({portsRoot, ...blobReaders(options)});
    fs.writeFileSync(options.output, JSON.stringify(inventory, null, 2) + '\n');
    const roots = inventory.files.filter(file => file.ledger_root).length;
    const bytes = inventory.files.reduce((sum, file) => sum + file.size_bytes, 0);
    console.log(`derived authority inventory: ${roots} ledger roots, ${inventory.files.length} files, ${bytes} bytes`);
  } catch (error) {
    console.error(error instanceof MissingAuthorityBlobs ? `${error.message}\nIngest the missing evidence into the store (see publication/CURRENT-HEAD-AUTHORITY-EVIDENCE.md).` : error.message);
    process.exit(1);
  }
}
