#!/usr/bin/env bash
# Add every path of a derived authority inventory to this clone's
# info/exclude, so restored store-backed evidence never shows as untracked
# (consolidated validation refuses an untracked path) and a ledger rebind
# needs no .gitignore edit. Only store-backed paths are listed, so newly
# authored evidence elsewhere stays visible. Lines are only ever added: the
# exclude file is shared by every worktree of the clone, and other branches
# may have restored other inventories.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo 'usage: exclude-restored-authority-evidence.sh REPO INVENTORY' >&2
  exit 64
fi
REPO="$1"
INVENTORY="$2"
EXCLUDE="$(git -C "${REPO}" rev-parse --path-format=absolute --git-path info/exclude)"
mkdir -p "$(dirname -- "${EXCLUDE}")"
touch "${EXCLUDE}"

exec 9<>"${EXCLUDE}.theme-lab-lock"
flock 9
node - "${INVENTORY}" "${EXCLUDE}" <<'EOF'
const fs = require('node:fs');
const [inventoryFile, excludeFile] = process.argv.slice(2);
const pattern = file => '/' + file.replace(/[\\*?[]/gu, match => `\\${match}`);
const present = new Set(fs.readFileSync(excludeFile, 'utf8').split('\n'));
const added = JSON.parse(fs.readFileSync(inventoryFile, 'utf8')).files
  .map(row => pattern(row.relative_path)).filter(line => !present.has(line));
if (added.length) {
  const tmp = `${excludeFile}.theme-lab-${process.pid}`;
  const current = fs.readFileSync(excludeFile, 'utf8');
  fs.writeFileSync(tmp, current + (current && !current.endsWith('\n') ? '\n' : '') + added.join('\n') + '\n');
  fs.renameSync(tmp, excludeFile);
}
console.log(`authority evidence exclude: ${added.length} path(s) added`);
EOF
