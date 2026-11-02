#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: scripts/run-browser-test-no-external-network.sh COMMAND [ARG...]" >&2
  exit 2
fi

if [[ "${WIKIJUMP_BROWSER_TEST_NETNS_ACTIVE:-}" == "1" ]]; then
  exec "$@"
fi

for command in unshare ip; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "browser test isolation requires ${command}" >&2
    exit 2
  fi
done

export CARGO_NET_OFFLINE=true
export PIP_NO_INDEX=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PNPM_CONFIG_OFFLINE=true
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NO_PROXY="localhost,127.0.0.1,::1,.localhost"
export no_proxy="${NO_PROXY}"

printf -v COMMAND_Q '%q ' "$@"

# Prefer an unprivileged user+network namespace. Some hosted Linux runners
# disable uid_map writes for unprivileged namespaces even though their sudo
# policy permits a root-created network namespace. In that environment create
# only the network namespace with sudo, configure loopback while privileged,
# then drop back to the invoking uid/gid before executing any test process.
if unshare -Urn sh -ceu 'ip link set lo up' >/dev/null 2>&1; then
  exec unshare -Urn sh -ceu "
    ip link set lo up
    export WIKIJUMP_BROWSER_TEST_NETNS_ACTIVE=1
    exec ${COMMAND_Q}
  "
fi

if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  if ! command -v setpriv >/dev/null 2>&1; then
    echo "browser test isolation sudo fallback requires setpriv" >&2
    exit 2
  fi
  CALLER_UID="$(id -u)"
  CALLER_GID="$(id -g)"
  exec sudo -n -E unshare -n sh -ceu "
    ip link set lo up
    export WIKIJUMP_BROWSER_TEST_NETNS_ACTIVE=1
    exec setpriv --reuid=${CALLER_UID} --regid=${CALLER_GID} --clear-groups ${COMMAND_Q}
  "
fi

echo "browser test isolation requires an unprivileged user namespace or passwordless sudo" >&2
exit 2
