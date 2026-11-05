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
# Key names are data, never shell code. The scan, the batch split, and the
# UNLINK calls run as one pipeline inside the container, and xargs runs the
# CLI directly, so each scanned key reaches UNLINK as one literal argument.
# A key name containing spaces, quotes, `$(...)`, backticks, or semicolons is
# deleted as a key; it is never word-split, substituted, or executed. No batch
# of keys is ever interpolated into a command line on either side of the
# `docker exec` boundary.
#
# Usage:
#   scripts/clear-article-view-cache.sh --container NAME [--batch N] [--execute]
#
# Options:
#   --container NAME  Valkey container to talk to (required)
#   --batch N         Upper bound on keys per UNLINK round trip (default 500)
#   --execute         Actually delete. Without this the script only counts the
#                     keys and prints what it would delete.
#
# The deletion can run while the cache serves traffic: at worst a page view
# misses the cache and re-renders, which is what a cold cache does anyway.

set -euo pipefail

CONTAINER=""
BATCH=500
EXECUTE=false
PATTERN='deepwell:article-view:page:*'

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

# The CLI binary differs between images.
CLI="valkey-cli"
if ! docker exec "${CONTAINER}" sh -c 'command -v "$1" >/dev/null 2>&1' sh "${CLI}"; then
  CLI="redis-cli"
  docker exec "${CONTAINER}" sh -c 'command -v "$1" >/dev/null 2>&1' sh "${CLI}" 2>/dev/null || {
    echo "clear-article-view-cache: neither valkey-cli nor redis-cli exists in ${CONTAINER}" >&2
    exit 2
  }
fi

count=$(docker exec "${CONTAINER}" "${CLI}" --scan --pattern "${PATTERN}" | wc -l)
count=$(printf '%s' "${count}" | tr -d '[:space:]')
echo "article-view keys: ${count}"

if [[ "${EXECUTE}" != true ]]; then
  echo "dry run: pass --execute to delete ${count} keys"
  exit 0
fi

if [[ "${count}" -eq 0 ]]; then
  echo "done: deleted 0 article-view keys"
  exit 0
fi

# One in-container pipeline: SCAN produces newline-separated keys, tr turns the
# separators into NULs, and xargs runs `UNLINK` on batches of at most $batch
# keys. The program text below is constant: the CLI name, pattern, and batch
# size arrive as positional parameters, so no scanned key is ever part of a
# command string, and xargs passes keys as literal exec arguments. Each UNLINK
# reply is a count; the host sums the replies to report the true total.
# shellcheck disable=SC2016
deleted=$(
  docker exec "${CONTAINER}" sh -c '
    cli=$1
    pattern=$2
    batch=$3
    "$cli" --scan --pattern "$pattern" --count "$batch" \
      | tr "\n" "\000" \
      | xargs -0 -r -n "$batch" "$cli" UNLINK
  ' sh "${CLI}" "${PATTERN}" "${BATCH}" \
    | awk '{ total += $1 } END { printf "%d\n", total }'
)

echo "done: deleted ${deleted} article-view keys"
if [[ "${deleted}" -ne "${count}" ]]; then
  echo "note: ${count} keys were present when counted; ${deleted} UNLINKed" >&2
fi
