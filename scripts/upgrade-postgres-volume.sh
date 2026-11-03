#!/usr/bin/env bash
# Upgrade a stopped PostgreSQL 17 data volume in place to the current server
# image's major version. See install/standing/README.md for Standing.
#
#   scripts/upgrade-postgres-volume.sh <volume> [--check] [--rollback-volume <name>]
#
# --check runs pg_upgrade's compatibility check and changes nothing.
# --rollback-volume first copies the volume to a new volume and compares the
# copy. The upgrade itself uses hard links and cannot be undone, so without a
# rollback volume the old cluster is gone once it succeeds.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=wikijump-postgres-upgrade
volume="${1:?usage: upgrade-postgres-volume.sh <volume> [--check] [--rollback-volume <name>]}"
shift
mode=upgrade
rollback=
while (($#)); do
  case "$1" in
    --check) mode=check; shift ;;
    --rollback-volume) rollback="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

docker volume inspect "${volume}" >/dev/null
consumers="$(docker ps --filter "volume=${volume}" --format '{{.Names}}')"
if [[ -n "${consumers}" ]]; then
  echo "stop the containers using ${volume} first: ${consumers}" >&2
  exit 1
fi

docker build --quiet --tag "${IMAGE}" \
  --file "${ROOT}/install/common/postgres/upgrade/Dockerfile" "${ROOT}" >/dev/null

if [[ -n "${rollback}" ]]; then
  if docker volume inspect "${rollback}" >/dev/null 2>&1; then
    echo "rollback volume ${rollback} already exists" >&2
    exit 1
  fi
  docker volume create "${rollback}" >/dev/null
  docker run --rm --network none --entrypoint sh \
    --volume "${volume}:/source:ro" --volume "${rollback}:/copy" "${IMAGE}" \
    -c 'cp -a /source/. /copy/ && diff -r /source /copy'
  echo "copied ${volume} to ${rollback}"
fi

docker run --rm --network none --volume "${volume}:/volume" \
  --entrypoint wikijump-upgrade-cluster "${IMAGE}" "${mode}"
