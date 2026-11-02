#!/usr/bin/env bash
# Restore this checkout's SHA-pinned adaptation-authority evidence from the
# content-addressed store (#2451, #2501). The evidence bytes live in the store,
# not in Git; restoring hardlinks the verified read-only blobs, so it costs no
# disk. Without the store this exits non-zero and the authority check stays
# failed (fail-closed).
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "${HERE}/../../../../" && pwd)"
STORE="${THEME_LAB_AUTHORITY_STORE:-${HOME}/.local/state/wikijump/theme-lab/authority-object-store-v1}"

if [[ ! -d "${STORE}" ]]; then
  echo "Theme Lab authority store not found: ${STORE} (set THEME_LAB_AUTHORITY_STORE)" >&2
  exit 1
fi

# The inventory is derived from the tracked ledger and the store on every run,
# so an adaptation-ledger rebind needs no inventory edit and no re-pinning.
INVENTORY="$(mktemp)"
trap 'rm -f "${INVENTORY}"' EXIT
node "${HERE}/derive-authority-inventory.mjs" --store "${STORE}" --checkout "${REPO}" --output "${INVENTORY}"
INVENTORY_SHA="$(sha256sum "${INVENTORY}" | cut -d' ' -f1)"
python3 -I "${HERE}/content-addressed-authority-store.py" \
  --mode restore --store-root "${STORE}" --destination-root "${REPO}" \
  --inventory "${INVENTORY}" --inventory-sha256 "${INVENTORY_SHA}" --apply --link
"${HERE}/exclude-restored-authority-evidence.sh" "${REPO}" "${INVENTORY}"
