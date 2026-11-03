#!/bin/bash
# Runs inside the upgrade image with the cluster's volume at /volume. The volume
# root is the data directory, so the new cluster is built in a subdirectory, on
# the same filesystem for --link, and moved up once pg_upgrade has succeeded.
set -euo pipefail

mode="$1"
new=/volume/.pg-upgrade-new
superuser=wikijump
hba=/tmp/upgrade/pg_hba.conf

if [[ "${mode}" != check && "${mode}" != upgrade ]]; then
  echo "usage: wikijump-upgrade-cluster check|upgrade" >&2
  exit 2
fi
if [[ "$(id -u)" == 0 ]]; then
  install -d -o postgres -g postgres /tmp/upgrade
  exec gosu postgres "$0" "$@"
fi

# The same lock the server entrypoint holds, so no server can start meanwhile.
exec 9</volume
if ! flock -n 9; then
  echo "a running server holds the lock on this volume" >&2
  exit 1
fi

version="$(cat /volume/PG_VERSION)"
case "${version}" in
  17) old_bin=/opt/pg17/bin ;;
  19) old_bin=/opt/pg19rc1/bin ;;
  *)
    echo "no binaries for a PostgreSQL ${version} cluster" >&2
    exit 1
    ;;
esac

unset PGDATA
cd /tmp/upgrade
printf 'local all all trust\n' > "${hba}"
rm -rf "${new}"

# pg_upgrade requires the new cluster's checksum setting to match, and initdb
# enables checksums by default.
checksums=--no-data-checksums
if "${old_bin}/pg_controldata" /volume | grep -Eq '^Data page checksum version: +[1-9]'; then
  checksums=--data-checksums
fi
initdb -D "${new}" -U "${superuser}" --locale en_US.UTF-8 --encoding UTF8 "${checksums}" >/dev/null

catalog_version() {
  "$1" "$2" | sed -n 's/^Catalog version number: *//p'
}
if [[ "$(catalog_version "${old_bin}/pg_controldata" /volume)" == "$(catalog_version pg_controldata "${new}")" ]]; then
  rm -rf "${new}"
  echo "the server image already reads this cluster's catalog; nothing to upgrade"
  exit 0
fi

cp /volume/pg_hba.conf /volume/pg_ident.conf /volume/postgresql.auto.conf "${new}/"

upgrade_args=(
  --old-bindir "${old_bin}" --new-bindir /usr/local/bin
  --old-datadir /volume --new-datadir "${new}"
  --username "${superuser}" --socketdir /tmp/upgrade --link --jobs 4
  --old-options "-c hba_file=${hba}" --new-options "-c hba_file=${hba}"
)
if [[ "${mode}" == check ]]; then
  pg_upgrade --check "${upgrade_args[@]}"
  rm -rf "${new}"
  exit 0
fi
pg_upgrade "${upgrade_args[@]}"

# --link has made the old cluster unstartable, and its data lives on through the
# hard links in the new cluster, so nothing below can lose a relation file.
find /volume -mindepth 1 -maxdepth 1 ! -name .pg-upgrade-new -exec rm -rf {} +
find "${new}" -mindepth 1 -maxdepth 1 -exec mv -t /volume {} +
rmdir "${new}"

# Planner statistics carry over except extended statistics; fill in what is
# missing before the server takes traffic.
pg_ctl -D /volume -w start -o "-c listen_addresses='' -c unix_socket_directories=/tmp/upgrade -c hba_file=${hba}" >/dev/null
if [[ -f update_extensions.sql ]]; then
  psql -h /tmp/upgrade -U "${superuser}" -d postgres -v ON_ERROR_STOP=1 -f update_extensions.sql
fi
vacuumdb -h /tmp/upgrade -U "${superuser}" --all --analyze-in-stages --missing-stats-only
pg_ctl -D /volume -w stop >/dev/null
echo "upgraded to $(postgres --version)"
