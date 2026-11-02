#!/usr/bin/env bash
# Restore this checkout's current campaign evidence (#2506) from the shared
# content-addressed store. The tracked inventory is the publication manifest;
# its SHA-256 is pinned below, and the restore verifies the receipt and run
# contracts it names. Exit 2 means the campaign evidence is not published yet
# (INCONCLUSIVE, not a pass); any other failure is fail-closed.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "${HERE}/../../../../" && pwd)"
STORE="${THEME_LAB_EVIDENCE_STORE:-${HOME}/.local/state/wikijump/theme-lab/authority-object-store-v1}"
MANIFEST="${HERE}/../publication/current-campaign-evidence-manifest.json"
# Pinned when the manifest is published (set in the same commit as the manifest).
MANIFEST_SHA=51bfe7a808a96a02b0ef70aeeab345528cc7b2fc49f52fb4eb893b1e91a48abd

if [[ ! -e "${MANIFEST}" && ! -L "${MANIFEST}" ]]; then
  cat >&2 <<MSG
Current campaign evidence is not published yet: ${MANIFEST} is absent.
This is INCONCLUSIVE (exit 2), not a pass. To publish it, from a checkout whose
check-campaign-completion.mjs passes:
  python3 -I install/local/theme-lab/scripts/campaign-evidence-store.py \\
    --mode campaign-inventory --checkout-root <checkout> --store-root "${STORE}" \\
    --output install/local/theme-lab/publication/current-campaign-evidence-manifest.json
Then commit the manifest and pin its SHA-256 in MANIFEST_SHA in this script.
MSG
  exit 2
fi
if [[ -L "${MANIFEST}" ]]; then
  echo "Campaign evidence manifest is a symlink: ${MANIFEST}" >&2
  exit 1
fi
if ! [[ "${MANIFEST_SHA}" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Campaign evidence manifest is present but MANIFEST_SHA is not pinned (fail-closed)." >&2
  exit 1
fi
if [[ ! -d "${STORE}" ]]; then
  echo "Theme Lab evidence store not found: ${STORE} (set THEME_LAB_EVIDENCE_STORE)" >&2
  exit 1
fi
python3 -I "${HERE}/campaign-evidence-store.py" \
  --mode campaign-restore --checkout-root "${REPO}" --store-root "${STORE}" \
  --inventory "${MANIFEST}" --inventory-sha256 "${MANIFEST_SHA}" --apply --link
# Keep the restored evidence out of git status: every path in the same
# pinned manifest the restore just verified joins the clone's info/exclude
# (mirrors the authority restore's exclude step).
"${HERE}/exclude-restored-campaign-evidence.sh" "${REPO}" "${MANIFEST}"
