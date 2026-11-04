#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
suffix="$$-${RANDOM}"
volume="wikijump-pg-upgrade-test-${suffix}"
rollback="${volume}-rollback"
container="wikijump-pg-upgrade-test-${suffix}"
old_image="$(sed -n 's/^COPY --from=\(postgres:17[^ ]*\) .*/\1/p' "${ROOT}/install/common/postgres/upgrade/Dockerfile")"
new_image="wikijump-pg-upgrade-test-server"

cleanup() {
  docker rm -fv "${container}" "${container}-second" "${container}-a" "${container}-b" >/dev/null 2>&1 || true
  rm -f "${container}-second.log"
  docker volume rm "${volume}" "${rollback}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

start() {
  docker run -d --name "${container}" --network none \
    -e POSTGRES_DB=wikijump -e POSTGRES_USER=wikijump -e POSTGRES_PASSWORD=wikijump \
    -e POSTGRES_INITDB_ARGS="--locale en_US.UTF-8" \
    --volume "${volume}:/var/lib/postgresql/data" -e PGDATA=/var/lib/postgresql/data \
    "$1" >/dev/null
  for _ in $(seq 60); do
    if docker exec "${container}" pg_isready -q -U wikijump -d wikijump -h 127.0.0.1; then
      return
    fi
    sleep 1
  done
  docker logs "${container}" >&2
  echo "server did not become ready" >&2
  exit 1
}

sql() {
  docker exec "${container}" psql -U wikijump -d wikijump -h 127.0.0.1 -At -v ON_ERROR_STOP=1 -c "$1"
}

stop() {
  docker stop -t 60 "${container}" >/dev/null
  docker rm -v "${container}" >/dev/null
}

docker build --quiet --tag "${new_image}" --file "${ROOT}/install/local/postgres/Dockerfile" "${ROOT}" >/dev/null
docker volume create "${volume}" >/dev/null

start "${old_image}"
sql "CREATE EXTENSION pgcrypto;
     CREATE TABLE upgrade_probe (id BIGINT PRIMARY KEY, body TEXT, tags TEXT[]);
     CREATE INDEX ON upgrade_probe USING GIN (tags);
     INSERT INTO upgrade_probe
       SELECT n, repeat(encode(digest(n::text, 'sha256'), 'hex'), 500), ARRAY['tag' || n % 10]
       FROM generate_series(1, 5000) AS n;
     ANALYZE upgrade_probe;"
expected="$(sql "SELECT count(*), md5(string_agg(body, '' ORDER BY id)) FROM upgrade_probe")"
stop

"${ROOT}/scripts/upgrade-postgres-volume.sh" "${volume}" --check >/dev/null 2>&1
"${ROOT}/scripts/upgrade-postgres-volume.sh" "${volume}" --rollback-volume "${rollback}" >/dev/null 2>&1

start "${new_image}"
major="$(docker run --rm --entrypoint sh "${new_image}" -c 'echo "${PG_MAJOR}"')"
[[ "$(sql "SHOW server_version_num")" == "${major}"* ]]
[[ "$(sql "SELECT count(*), md5(string_agg(body, '' ORDER BY id)) FROM upgrade_probe")" == "${expected}" ]]
[[ "$(sql "SELECT count(*) FROM upgrade_probe WHERE tags && ARRAY['tag3']")" == 500 ]]
[[ "$(sql "SELECT count(*) FROM pg_stats WHERE tablename = 'upgrade_probe'")" != 0 ]]
stop

start "${new_image}"
second="${container}-second"
if docker run --name "${second}" --network none -e POSTGRES_PASSWORD=x \
  --volume "${volume}:/var/lib/postgresql/data" "${new_image}" >/dev/null 2>"${second}.log"; then
  echo "a second server started on one data directory" >&2
  exit 1
fi
grep -q "another server holds" "${second}.log"
rm -f "${second}.log"
docker rm -v "${second}" >/dev/null
[[ "$(sql "SELECT 1")" == 1 ]]
stop

start "${new_image}"
stop

"${ROOT}/scripts/upgrade-postgres-volume.sh" "${volume}" 2>&1 | grep -q "nothing to upgrade"

docker create --name "${container}-a" --volume "${volume}:/x" "${new_image}" >/dev/null
docker create --name "${container}-b" --volume "${volume}:/x" "${new_image}" >/dev/null
if "${ROOT}/scripts/upgrade-postgres-volume.sh" "${volume}" --check >/dev/null 2>&1; then
  echo "the upgrade tool accepted a volume attached to two stacks" >&2
  exit 1
fi
docker rm -v "${container}-a" "${container}-b" >/dev/null

docker run --rm --network none --entrypoint sh --volume "${rollback}:/copy:ro" "${new_image}" \
  -c '[ "$(cat /copy/PG_VERSION)" = 17 ] && [ -f /copy/global/pg_control ]'

echo "volume upgrade: ok"
