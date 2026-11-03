#!/bin/sh
# Two servers on one data directory corrupt it, and PID namespaces hide each from
# the other's postmaster.pid. A kernel lock on the directory works across
# containers. The descriptor stays open through exec into the image's entrypoint
# and the server, so the lock lasts exactly as long as the server does.
set -eu

case "${1:-}" in
  postgres | -*)
    exec 9<"${PGDATA}"
    if ! flock -n 9; then
      echo "another server holds the lock on ${PGDATA}; refusing to start" >&2
      exit 1
    fi
    ;;
esac

exec docker-entrypoint.sh "$@"
