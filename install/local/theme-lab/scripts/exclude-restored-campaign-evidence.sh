#!/usr/bin/env bash
# Add every path of the tracked campaign evidence manifest to this clone's
# info/exclude, prefixed with the Theme Lab directory, so evidence restored
# by restore-checkout-campaign-evidence.sh never shows as untracked
# (consolidated validation refuses an untracked path). Only manifest paths
# are listed, so newly authored evidence elsewhere stays visible. Lines are
# only ever added: the exclude file is shared by every worktree of the
# clone, and other branches may have restored other manifests. Mirrors
# exclude-restored-authority-evidence.sh for the campaign inventory, whose
# paths are relative to the Theme Lab directory rather than the checkout.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo 'usage: exclude-restored-campaign-evidence.sh REPO MANIFEST' >&2
  exit 64
fi
REPO="$1"
MANIFEST="$2"
EXCLUDE="$(git -C "${REPO}" rev-parse --path-format=absolute --git-path info/exclude)"
mkdir -p "$(dirname -- "${EXCLUDE}")"
touch "${EXCLUDE}"

exec 9<>"${EXCLUDE}.theme-lab-lock"
flock 9
node - "${MANIFEST}" "${EXCLUDE}" <<'EOF'
const fs = require('node:fs');
const [manifestFile, excludeFile] = process.argv.slice(2);
const pattern = file => '/install/local/theme-lab/' + file.replace(/[\\*?[]/gu, match => `\\${match}`);
const present = new Set(fs.readFileSync(excludeFile, 'utf8').split('\n'));
const added = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).files
  .map(row => pattern(row.relative_path)).filter(line => !present.has(line));
if (added.length) {
  const tmp = `${excludeFile}.theme-lab-${process.pid}`;
  const current = fs.readFileSync(excludeFile, 'utf8');
  fs.writeFileSync(tmp, current + (current && !current.endsWith('\n') ? '\n' : '') + added.join('\n') + '\n');
  fs.renameSync(tmp, excludeFile);
}
console.log(`campaign evidence exclude: ${added.length} path(s) added`);
EOF
