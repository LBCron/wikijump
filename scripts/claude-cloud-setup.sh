#!/usr/bin/env bash
# Wikijump setup script for Claude Code cloud sessions (Anthropic-hosted
# environments). Paste this file's contents into the environment's
# "Setup script" field at claude.ai/code (see docs/agents/claude-cloud.md),
# or run it as root in a fresh Ubuntu 24.04 VM.
#
# Constraints from the cloud environment documentation:
#   * runs as root, before Claude Code launches
#   * must exit 0 or the session does not start
#   * must finish within roughly five minutes or the environment is
#     not cached as a snapshot (later sessions then re-run it)
# The preinstalled image already provides Node 20/21/22, pnpm, Rust,
# Docker, PostgreSQL 16 and Redis 7. This script adds what Wikijump
# pins on top: Node 24.22.1, Rust 1.99.1, pnpm 11.10.0, and dependency
# prefetches so sessions start warm.
set -Eeuo pipefail

script_revision=2026-10-26.3
node_version=24.22.1
required_rust_version=1.99.1
pnpm_version=11.10.0
trusted_node24_dir=/opt/wikijump/trusted-node24
node24_env=/root/.config/wikijump/node24.sh

printf 'Wikijump Claude Cloud setup revision %s\n' "$script_revision"

retry() {
  local attempt=1 max_attempts=${RETRY_MAX:-5} delay=2 status
  until "$@"; do
    status=$?
    if (( attempt >= max_attempts )); then
      printf 'Command failed after %d attempts (exit %d):' "$attempt" "$status" >&2
      printf ' %q' "$@" >&2
      printf '\n' >&2
      return "$status"
    fi
    printf 'Command failed (attempt %d/%d); retrying in %ds\n' "$attempt" "$max_attempts" "$delay" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

find_repo() {
  local candidate
  for candidate in "${WIKIJUMP_CLAUDE_REPO:-}" "$PWD" "$HOME"/* /workspace/* /root/*; do
    [[ -n "$candidate" && -f "$candidate/deepwell/Cargo.toml" && -f "$candidate/framerail/package.json" ]] || continue
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

install_node24() {
  if [[ -x "$trusted_node24_dir/bin/node" ]] && \
     [[ "$("$trusted_node24_dir/bin/node" --version)" == "v$node_version" ]]; then
    return 0
  fi
  # Node.js via the npm `node` package: registry.npmjs.org is in the
  # Trusted network allowlist, so this depends on no other host. The
  # version is pinned exactly, matching framerail's engines field.
  # Install into the trusted directory as a dedicated npm prefix. The
  # preinstalled Node lives in npm's default global prefix (for Node
  # 22, /opt/node22) and occupies its bin/node, so installing the
  # `node` package there fails with EEXIST and the setup aborts. A
  # dedicated, initially empty prefix has no bin/node yet, so npm can
  # create it, and the result is exactly the trusted tree the rest of
  # this script activates.
  rm -rf "$trusted_node24_dir"
  mkdir -p "$trusted_node24_dir"
  retry npm install --global --prefix "$trusted_node24_dir" \
    --no-audit --no-fund "node@${node_version}"
  [[ -x "$trusted_node24_dir/bin/node" ]]
  [[ "$("$trusted_node24_dir/bin/node" --version)" == "v$node_version" ]]
  hash -r
}

activate_node24() {
  local node_bin="$trusted_node24_dir/bin"
  case ":${PATH}:" in
    *":$node_bin:"*) ;;
    *) PATH="$node_bin:$PATH" ;;
  esac
  export PATH
  hash -r
  mkdir -p "$(dirname "$node24_env")"
  {
    printf '_wikijump_node24_bin=%q\n' "$node_bin"
    cat <<'NODE_ENV'
case ":${PATH}:" in
  *":${_wikijump_node24_bin}:"*) ;;
  *) PATH="${_wikijump_node24_bin}:${PATH}" ;;
esac
export PATH
unset _wikijump_node24_bin
NODE_ENV
  } >"$node24_env"
  chmod 0644 "$node24_env"
  tee /etc/profile.d/wikijump-node24.sh >/dev/null <<'PROFILE_ENV'
[ -r /root/.config/wikijump/node24.sh ] && . /root/.config/wikijump/node24.sh
PROFILE_ENV
  chmod 0644 /etc/profile.d/wikijump-node24.sh
  [[ "$(node --version)" == "v$node_version" ]]
}

install_rust() {
  if ! command -v rustup >/dev/null 2>&1; then
    # Download first, then run: piping curl into sh without pipefail
    # would treat a failed download as success (empty input).
    local installer
    installer=$(mktemp)
    retry curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o "$installer"
    [[ -s "$installer" ]]
    sh "$installer" -y --profile minimal --no-modify-path
    rm -f "$installer"
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
  retry rustup toolchain install "$required_rust_version" \
    --profile minimal --component clippy,rustfmt,rust-src --no-self-update
  rustup default "$required_rust_version"
}

install_pnpm() {
  # The trusted directory carries no npm of its own, so the npm on
  # PATH is still the preinstalled one, whose default global prefix is
  # the preinstalled Node's tree. Pass --prefix explicitly so pnpm
  # lands beside the trusted node.
  local installed
  installed=$(pnpm --version 2>/dev/null || true)
  if [[ "$installed" != "$pnpm_version" ]] || \
     [[ "$(command -v pnpm)" != "$trusted_node24_dir/bin/pnpm" ]]; then
    corepack disable pnpm >/dev/null 2>&1 || true
    retry npm install --global --prefix "$trusted_node24_dir" \
      --no-audit --no-fund "pnpm@${pnpm_version}"
    hash -r
  fi
  [[ "$(pnpm --version)" == "$pnpm_version" ]]
  [[ "$(command -v pnpm)" == "$trusted_node24_dir/bin/pnpm" ]]
}

install_services_helper() {
  # Per-session services are started by the maintenance script through
  # this helper; the environment snapshot keeps files, not processes.
  # The helper is idempotent and never wipes state: a resumed session
  # keeps its database and cache.
  tee /usr/local/bin/wikijump-claude-services >/dev/null <<'SERVICES'
#!/usr/bin/env bash
set -Eeuo pipefail
service postgresql start || true
service redis-server start || true
for _ in $(seq 1 30); do pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break; sleep 1; done
pg_isready -h 127.0.0.1 -U postgres >/dev/null
for _ in $(seq 1 30); do redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -qx PONG && break; sleep 1; done
redis-cli -h 127.0.0.1 ping | grep -qx PONG
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "ALTER USER postgres PASSWORD 'postgres'" >/dev/null
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'wikijump_claude'" | grep -q 1; then
  runuser -u postgres -- createdb wikijump_claude
fi
SERVICES
  chmod 0755 /usr/local/bin/wikijump-claude-services
}

export npm_config_fetch_retries=5
export npm_config_fetch_retry_factor=2
export npm_config_fetch_retry_mintimeout=10000
export npm_config_fetch_retry_maxtimeout=120000
export CARGO_NET_RETRY=5
export CARGO_HTTP_TIMEOUT=120

install_node24
activate_node24
printf 'Using %s at %s\n' "$(node --version)" "$(command -v node)"
install_rust
printf 'Using %s\n' "$(rustc --version)"
install_pnpm
printf 'Using pnpm %s at %s\n' "$(pnpm --version)" "$(command -v pnpm)"
install_services_helper

repo=$(find_repo || true)
if [[ -n "${repo:-}" ]]; then
  printf 'Prefetching dependencies for %s\n' "$repo"
  # Independent prefetches run in parallel, each bounded, so a slow
  # registry cannot push setup past the environment cache window.
  # A failed prefetch is reported but never fails the setup: the
  # session can still fetch on demand.
  export RETRY_MAX=2
  declare -a pids=()
  ( timeout 240 pnpm --dir "$repo/framerail" fetch --ignore-scripts --frozen-lockfile ) & pids+=($!)
  ( timeout 240 pnpm --dir "$repo/install/local/wikidot-verification" fetch --ignore-scripts --frozen-lockfile ) & pids+=($!)
  ( timeout 240 pnpm --dir "$repo/locales/typed" fetch --ignore-scripts --frozen-lockfile ) & pids+=($!)
  ( timeout 240 cargo fetch --locked --manifest-path "$repo/deepwell/Cargo.toml" ) & pids+=($!)
  ( timeout 240 cargo fetch --locked --manifest-path "$repo/wws/Cargo.toml" ) & pids+=($!)
  ( timeout 240 cargo fetch --locked --manifest-path "$repo/locales/validator/Cargo.toml" ) & pids+=($!)
  failures=0
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      failures=$((failures + 1))
    fi
  done
  if (( failures > 0 )); then
    printf 'WARNING: %d dependency prefetch(es) failed or timed out; sessions will fetch on demand.\n' "$failures" >&2
  fi
else
  printf 'Wikijump clone not found during setup; dependency prefetch skipped.\n' >&2
fi

printf 'Wikijump Claude Cloud setup complete.\n'
