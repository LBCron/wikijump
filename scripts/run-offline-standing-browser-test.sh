#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: scripts/run-offline-standing-browser-test.sh COMMAND [ARG...]" >&2
  exit 2
fi
for command in unshare ip socat; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "offline standing browser isolation requires ${command}" >&2
    exit 2
  fi
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/wikijump-offline-browser.XXXXXX")"
HOST_PORT="${WIKIJUMP_OFFLINE_BROWSER_HOST_PORT:-443}"
if ! [[ "${HOST_PORT}" =~ ^[0-9]+$ ]] || (( HOST_PORT < 1 || HOST_PORT > 65535 )); then
  echo "WIKIJUMP_OFFLINE_BROWSER_HOST_PORT must be a TCP port" >&2
  exit 2
fi
SOCK="${TMP}/standing-${HOST_PORT}.sock"
HOST_BRIDGE_PID=""
cleanup() {
  if [[ -n "${HOST_BRIDGE_PID}" ]]; then
    kill "${HOST_BRIDGE_PID}" 2>/dev/null || true
    wait "${HOST_BRIDGE_PID}" 2>/dev/null || true
  fi
  rm -rf -- "${TMP}"
}
trap cleanup EXIT INT TERM

socat "UNIX-LISTEN:${SOCK},fork,mode=600" TCP:127.0.0.1:"${HOST_PORT}" &
HOST_BRIDGE_PID=$!
for _ in $(seq 1 100); do
  [[ -S "${SOCK}" ]] && break
  sleep 0.01
done
if [[ ! -S "${SOCK}" ]]; then
  echo "offline standing browser bridge did not create its Unix socket" >&2
  exit 2
fi

export CARGO_NET_OFFLINE=true
export PIP_NO_INDEX=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PNPM_CONFIG_OFFLINE=true
export npm_config_offline=true
export npm_config_update_notifier=false
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NO_PROXY="localhost,127.0.0.1,::1,.localhost"
export no_proxy="${NO_PROXY}"

printf -v COMMAND_Q '%q ' "$@"
printf -v SOCK_Q '%q' "${SOCK}"
printf -v PORT_Q '%q' "${HOST_PORT}"

unshare -Urn sh -ceu "
  ip link set lo up
  export WIKIJUMP_OFFLINE_BROWSER_NETNS_ACTIVE=1
  socat TCP-LISTEN:${PORT_Q},bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:${SOCK_Q} &
  bridge=\$!
  trap 'kill \"\$bridge\" 2>/dev/null || true' EXIT INT TERM
  sleep 0.05
  ${COMMAND_Q}
"
