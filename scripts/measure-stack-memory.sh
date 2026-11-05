#!/usr/bin/env bash
#
# measure-stack-memory.sh - read-only memory census of a running Wikijump stack.
#
# Prints, for every container of a Compose project (or an explicit list), the
# numbers the memory-reduction plan compares between phases:
#
#   * cgroup v2 memory.current / memory.peak / memory.stat (anon, file, shmem);
#   * process VmRSS, VmHWM and smaps_rollup PSS, summed over the processes in
#     the container (for PostgreSQL, the PSS sum, not RSS, is the meaningful
#     number: shared_buffers pages are counted once per backend in RSS);
#   * for the cache service: Valkey INFO memory, the article-view key census
#     and per-key size sample, and the persisted AOF/RDB size;
#   * for the database service: pg_stat_activity by state and the
#     memory-relevant settings;
#   * the Node heap is not exposed by Framerail, so only its process RSS is
#     reported.
#
# This is a check, not a record: it prints the current numbers and keeps no
# baseline. Rerun it whenever a number is in doubt.
#
# Usage:
#   scripts/measure-stack-memory.sh [options]
#
# Options:
#   --project NAME      Compose project to measure (default: wikijump-standing)
#   --containers LIST   Comma-separated container names instead of a project
#   --service NAME      Only this Compose service
#   --sample-keys N     Article-view keys to size with MEMORY USAGE (default 100)
#   --json              Emit the report as one JSON object instead of text
#   -h, --help          Show this help
#
# The script only reads. It never restarts, configures, or writes to the
# stack, and it never reads credentials into its output.

set -euo pipefail

PROJECT="wikijump-standing"
CONTAINERS=""
SERVICE=""
SAMPLE_KEYS=100
JSON=false

usage() {
  sed -n '2,/^# The script only reads/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --containers) CONTAINERS="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --sample-keys) SAMPLE_KEYS="$2"; shift 2 ;;
    --json) JSON=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "measure-stack-memory: unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null || {
  echo "measure-stack-memory: docker is required" >&2
  exit 2
}

if ! docker info >/dev/null 2>&1; then
  echo "measure-stack-memory: cannot reach the Docker daemon" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Container discovery
# ---------------------------------------------------------------------------

declare -a NAMES=() SERVICES=()

if [[ -n "${CONTAINERS}" ]]; then
  IFS=',' read -r -a NAMES <<< "${CONTAINERS}"
  for name in "${NAMES[@]}"; do
    SERVICES+=("$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "${name}" 2>/dev/null || echo unknown)")
  done
else
  mapfile -t NAMES < <(docker ps \
    --filter "label=com.docker.compose.project=${PROJECT}" \
    --format '{{.Names}}' | sort)
  if [[ ${#NAMES[@]} -eq 0 ]]; then
    echo "measure-stack-memory: no running containers for project '${PROJECT}'" >&2
    exit 1
  fi
  for name in "${NAMES[@]}"; do
    SERVICES+=("$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "${name}")")
  done
fi

if [[ -n "${SERVICE}" ]]; then
  declare -a FILTERED_NAMES=() FILTERED_SERVICES=()
  for i in "${!NAMES[@]}"; do
    if [[ "${SERVICES[$i]}" == "${SERVICE}" ]]; then
      FILTERED_NAMES+=("${NAMES[$i]}")
      FILTERED_SERVICES+=("${SERVICES[$i]}")
    fi
  done
  NAMES=("${FILTERED_NAMES[@]}")
  SERVICES=("${FILTERED_SERVICES[@]}")
  if [[ ${#NAMES[@]} -eq 0 ]]; then
    echo "measure-stack-memory: no running container for service '${SERVICE}'" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Per-container probes
# ---------------------------------------------------------------------------

# Read the cgroup v2 counters from inside the container. Docker always mounts
# the container's own cgroup hierarchy at /sys/fs/cgroup, so this needs no
# knowledge of the host's cgroup layout.
cgroup_probe() {
  local name="$1"
  docker exec "${name}" sh -c '
    for file in memory.current memory.peak; do
      if [ -r "/sys/fs/cgroup/${file}" ]; then
        printf "%s=%s\n" "${file}" "$(cat "/sys/fs/cgroup/${file}")"
      else
        printf "%s=\n" "${file}"
      fi
    done
    if [ -r /sys/fs/cgroup/memory.stat ]; then
      for key in anon file shmem; do
        awk -v key="${key}" "\$1 == key { print key \"=\" \$2 }" /sys/fs/cgroup/memory.stat
      done
    fi
  ' 2>/dev/null || true
}

# Sum VmRSS, VmHWM and Pss over every process in the container. Runs inside
# the container so that its PID namespace is visible. The probe uses only
# shell builtins: the silo image has no sed or grep. VmRSS/VmHWM are
# world-readable, but smaps_rollup is not: reading it for a process owned by
# another user needs CAP_SYS_PTRACE, which a container process does not have
# by default. If the first pass leaves PSS unreadable, retry with
# --privileged on the exec only; that grants the capability to this one
# process and changes no container configuration. Zombie processes have no
# memory and no smaps_rollup; they are counted, not reported missing.
process_probe() {
  local name="$1"
  local probe='
    for dir in /proc/[0-9]*; do
      [ -r "${dir}/status" ] || continue
      rss= hwm= state=
      while IFS= read -r line; do
        set -f
        set -- ${line}
        set +f
        case "$1" in
          State:) state=$2 ;;
          VmRSS:) rss=$2 ;;
          VmHWM:) hwm=$2 ;;
        esac
      done < "${dir}/status"
      if [ "${state}" = Z ]; then
        printf "0 0 0 zombie\n"
        continue
      fi
      pss=
      if [ -r "${dir}/smaps_rollup" ]; then
        while IFS= read -r line; do
          set -f
          set -- ${line}
          set +f
          case "$1" in
            Pss:) pss=$2; break ;;
          esac
        done < "${dir}/smaps_rollup"
      fi
      printf "%s %s %s\n" "${rss:-0}" "${hwm:-0}" "${pss:-missing}"
    done
  '
  local summarize='
    $4 == "zombie" { zombies += 1; next }
    $3 == "missing" { missing += 1; next }
    { count += 1; rss += $1; hwm += $2; pss += $3 }
    END {
      printf "proc_count=%d\n", count + missing + zombies
      printf "proc_zombie_count=%d\n", zombies
      printf "proc_rss_kib=%d\n", rss
      printf "proc_hwm_kib=%d\n", hwm
      printf "proc_pss_kib=%d\n", pss
      printf "proc_pss_missing=%d\n", missing
    }
  '
  local output source=plain
  output=$(docker exec "${name}" sh -c "${probe}" 2>/dev/null | awk "${summarize}")
  if awk -F= '/^proc_pss_missing=/ { exit !($2 > 0) }' <<< "${output}"; then
    local privileged
    privileged=$(docker exec --privileged "${name}" sh -c "${probe}" 2>/dev/null | awk "${summarize}")
    if ! awk -F= '/^proc_pss_missing=/ { exit !($2 > 0) }' <<< "${privileged}"; then
      output="${privileged}"
      source=privileged-exec
    fi
  fi
  printf 'proc_pss_source=%s\n' "${source}"
  printf '%s\n' "${output}"
}

docker_stats_probe() {
  local name="$1"
  docker stats --no-stream --format '{{.MemUsage}}' "${name}" 2>/dev/null || true
}

# Valkey census. Prints the counters the plan's #1 proof needs: used memory,
# key count and expiry state, evictions and hit rate, the article-view family
# count and size sample, and the persisted AOF/RDB size.
valkey_probe() {
  local name="$1"
  local cli="valkey-cli"
  if ! docker exec "${name}" sh -c "command -v ${cli}" >/dev/null 2>&1; then
    cli="redis-cli"
  fi

  docker exec "${name}" sh -c '
    cli="$1"
    sample_keys="$2"
    for field in used_memory used_memory_rss used_memory_peak; do
      value=$($cli INFO memory | awk -F: -v key="${field}" "\$1 == key { gsub(/\r/, \"\", \$2); print \$2 }")
      printf "valkey_%s=%s\n" "${field}" "${value}"
    done
    printf "valkey_maxmemory=%s\n" "$($cli CONFIG GET maxmemory | tail -n 1)"
    printf "valkey_maxmemory_policy=%s\n" "$($cli CONFIG GET maxmemory-policy | tail -n 1)"
    $cli INFO stats | awk -F: "
      \$1 == \"evicted_keys\" { gsub(/\r/, \"\", \$2); print \"valkey_evicted_keys=\" \$2 }
      \$1 == \"keyspace_hits\" { gsub(/\r/, \"\", \$2); print \"valkey_keyspace_hits=\" \$2 }
      \$1 == \"keyspace_misses\" { gsub(/\r/, \"\", \$2); print \"valkey_keyspace_misses=\" \$2 }
    "
    printf "valkey_dbsize=%s\n" "$($cli DBSIZE | tr -d \"\r\")"
    expires=$($cli INFO keyspace | awk -F, "/^db0:/ { split(\$2, pair, \"=\"); print pair[2] }")
    printf "valkey_db0_expires=%s\n" "${expires:-0}"

    pattern="deepwell:article-view:page:*"
    count=$(timeout 60 $cli --scan --pattern "${pattern}" | wc -l)
    printf "article_view_keys=%s\n" "${count}"

    if [ "${count}" -gt 0 ] && [ "${sample_keys}" -gt 0 ]; then
      timeout 60 $cli --scan --pattern "${pattern}" \
        | head -n "${sample_keys}" \
        | while read -r key; do
            $cli MEMORY USAGE "${key}" | tr -d "\r"
          done \
        | awk -v keys="${count}" "
            { samples += 1; total += \$1; if (\$1 > max) max = \$1 }
            END {
              if (samples > 0) {
                avg = total / samples
                printf \"article_view_sampled=%d\n\", samples
                printf \"article_view_avg_bytes=%d\n\", avg
                printf \"article_view_max_bytes=%d\n\", max
                printf \"article_view_estimated_total_bytes=%d\n\", avg * keys
              }
            }
          "
    fi

    aof=$(du -sb /data/appendonlydir 2>/dev/null | awk "{ print \$1 }")
    rdb=$(du -cb /data/*.rdb 2>/dev/null | awk "/total/ { print \$1 }")
    printf "valkey_aof_bytes=%s\n" "${aof:-0}"
    printf "valkey_rdb_bytes=%s\n" "${rdb:-0}"
  ' sh "${cli}" "${SAMPLE_KEYS}" 2>/dev/null || true
}

postgres_probe() {
  local name="$1"
  local user password
  user=$(docker exec "${name}" printenv POSTGRES_USER 2>/dev/null || echo wikijump)
  password=$(docker exec "${name}" printenv POSTGRES_PASSWORD 2>/dev/null || echo "")
  [[ -n "${password}" ]] || return 0

  docker exec -e PGPASSWORD="${password}" "${name}" \
    psql -h 127.0.0.1 -U "${user}" -d "${user}" -tA -F'=' -c "
      SELECT 'pg_' || name, setting
      FROM pg_settings
      WHERE name IN (
        'max_connections', 'superuser_reserved_connections', 'shared_buffers',
        'work_mem', 'maintenance_work_mem', 'effective_cache_size', 'jit',
        'max_parallel_workers_per_gather', 'max_parallel_workers'
      )
      ORDER BY name;
    " 2>/dev/null || true

  docker exec -e PGPASSWORD="${password}" "${name}" \
    psql -h 127.0.0.1 -U "${user}" -d "${user}" -tA -F'=' -c "
      SELECT 'pg_activity_' || coalesce(state, 'none'), count(*)
      FROM pg_stat_activity
      GROUP BY 1
      ORDER BY 1;
    " 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

host_probe() {
  awk '
    /^MemTotal:/ { printf "host_mem_total_kib=%d\n", $2 }
    /^MemAvailable:/ { printf "host_mem_available_kib=%d\n", $2 }
  ' /proc/meminfo
}

declare -a RECORDS=()
record() {
  RECORDS+=("$1")
}

while IFS= read -r line; do
  [[ -n "${line}" ]] && record "${line}"
done < <(host_probe)

for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  service="${SERVICES[$i]}"
  record "container=${name}"
  record "service=${service}"

  while IFS= read -r line; do
    [[ -n "${line}" ]] && record "cgroup_${line}"
  done < <(cgroup_probe "${name}")

  while IFS= read -r line; do
    [[ -n "${line}" ]] && record "${line}"
  done < <(process_probe "${name}")

  record "docker_stats_mem_usage=$(docker_stats_probe "${name}")"

  case "${service}" in
    cache)
      while IFS= read -r line; do
        [[ -n "${line}" ]] && record "${line}"
      done < <(valkey_probe "${name}")
      ;;
    database)
      while IFS= read -r line; do
        [[ -n "${line}" ]] && record "${line}"
      done < <(postgres_probe "${name}")
      ;;
    framerail)
      record "node_heap=none"
      ;;
  esac
  record "end_container=${name}"
done

if [[ "${JSON}" == true ]]; then
  printf '%s\n' "${RECORDS[@]}" | python3 -c '
import json, sys

entries = []
current = None
for raw in sys.stdin:
    line = raw.rstrip("\n")
    if not line:
        continue
    if line.startswith("container="):
        current = {"container": line.split("=", 1)[1]}
        entries.append(current)
        continue
    if line.startswith("end_container="):
        current = None
        continue
    if current is None:
        current = {"container": None}
        entries.append(current)
    key, _, value = line.partition("=")
    if value.lstrip("-").isdigit():
        value = int(value)
    current[key] = value
print(json.dumps(entries, indent=2, sort_keys=True))
'
else
  printf '%s\n' "${RECORDS[@]}"
fi
