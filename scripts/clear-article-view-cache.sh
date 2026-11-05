#!/usr/bin/env bash
#
# clear-article-view-cache.sh - delete the anonymous article-view cache family.
#
# The keys under `deepwell:article-view:page:*` are cache entries: each one is
# the serialized page view for one (renderer epoch, revision, public-content
# fence, permission fence, theme, ...) tuple. Before Deepwell expired these
# entries, every site write, permission change, re-render, and renderer
# promotion left its predecessor unreachable but resident, so a long-lived
# Valkey accumulated them without bound. Deleting the family is safe: every
# entry can be recomputed from PostgreSQL, and the fence keys that decide what
# is current are in other key families and are untouched.
#
# This script only deletes `deepwell:article-view:page:*` keys, in batches, with
# UNLINK. It never runs FLUSHDB or FLUSHALL: the RSMQ job queue and the
# public-content and permission fences share the database and must persist.
#
# Usage:
#   scripts/clear-article-view-cache.sh --container NAME [--batch N] [--execute]
#
# Options:
#   --container NAME  Valkey container to talk to (required)
#   --batch N         Keys per UNLINK round trip (default 500)
#   --execute         Actually delete. Without this the script only counts the
#                     keys and prints what it would delete.
#
# The deletion can run while the cache serves traffic: at worst a page view
# misses the cache and re-renders, which is what a cold cache does anyway.

set -euo pipefail

CONTAINER=""
BATCH=500
EXECUTE=false

usage() {
  sed -n '2,/^# The deletion can run/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2 ;;
    --batch) BATCH="$2"; shift 2 ;;
    --execute) EXECUTE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "clear-article-view-cache: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "${CONTAINER}" ]] || {
  echo "clear-article-view-cache: --container is required" >&2
  exit 2
}
[[ "${BATCH}" =~ ^[1-9][0-9]*$ ]] || {
  echo "clear-article-view-cache: --batch must be a positive integer" >&2
  exit 2
}

command -v docker >/dev/null || {
  echo "clear-article-view-cache: docker is required" >&2
  exit 2
}

# The valkey-cli binary differs between images.
CLI="valkey-cli"
if ! docker exec "${CONTAINER}" sh -c "command -v ${CLI}" >/dev/null 2>&1; then
  CLI="redis-cli"
fi

PATTERN='deepwell:article-view:page:*'

count=$(docker exec "${CONTAINER}" sh -c "${CLI} --scan --pattern '${PATTERN}' | wc -l")
count=$(printf '%s' "${count}" | tr -d '[:space:]')
echo "article-view keys: ${count}"

if [[ "${EXECUTE}" != true ]]; then
  echo "dry run: pass --execute to delete ${count} keys"
  exit 0
fi

deleted=0
while :; do
  batch=$(docker exec "${CONTAINER}" sh -c \
    "${CLI} --scan --pattern '${PATTERN}' --count ${BATCH} | head -n ${BATCH}")
  if [[ -z "${batch}" ]]; then
    break
  fi
  # shellcheck disable=SC2086
  removed=$(docker exec "${CONTAINER}" sh -c \
    "printf '%s\\n' ${batch} | xargs -r ${CLI} UNLINK")
  removed=$(printf '%s' "${removed}" | tr -d '[:space:]')
  deleted=$((deleted + removed))
  echo "deleted ${deleted}/${count}"
done

echo "done: deleted ${deleted} article-view keys"
