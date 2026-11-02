#!/usr/bin/env bash
# Wikijump per-session maintenance for Claude Code. Wired as a
# SessionStart hook in .claude/settings.json. In cloud sessions the
# environment snapshot restores files but not processes, so each
# session re-activates the pinned toolchains, refreshes dependency
# prefetches, and starts the local services. Outside the cloud
# (CLAUDE_CODE_REMOTE != true) this is a no-op, so the user's own
# machines are never touched.
set -Eeuo pipefail

if [[ "${CLAUDE_CODE_REMOTE:-}" != "true" ]]; then
  exit 0
fi

script_revision=2026-10-26.3
node_version=24.22.1
required_rust_version=1.99.1
pnpm_version=11.10.0
trusted_node24_dir=/opt/wikijump/trusted-node24

printf 'Wikijump Claude Cloud maintenance revision %s\n' "$script_revision"

retry() {
  local attempt=1 max_attempts=3 delay=2 status
  until "$@"; do
    status=$?
    if (( attempt >= max_attempts )); then
      printf 'Command failed after %d attempts (exit %d):' "$attempt" "$status" >&2
      printf ' %q' "$@" >&2
      printf '\n' >&2
      return "$status"
    fi
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

repo=""
for candidate in "${WIKIJUMP_CLAUDE_REPO:-}" "$PWD" "$HOME"/* /workspace/* /root/*; do
  [[ -n "$candidate" && -f "$candidate/deepwell/Cargo.toml" && -f "$candidate/framerail/package.json" ]] || continue
  repo="$candidate"
  break
done
if [[ -z "$repo" ]]; then
  printf 'Wikijump clone not found; maintenance skipped.\n' >&2
  exit 0
fi
cd "$repo"

if [[ ! -x "$trusted_node24_dir/bin/node" ]]; then
  printf 'Trusted Node %s is missing; the environment setup script has not run. Run it from the environment settings.\n' "$node_version" >&2
  exit 1
fi
export PATH="$trusted_node24_dir/bin:$HOME/.cargo/bin:$PATH"
hash -r
[[ "$(node --version)" == "v$node_version" ]]
rustup default "$required_rust_version" >/dev/null 2>&1 || true
printf 'Using %s / %s\n' "$(node --version)" "$(rustc --version)"

# A hook's own exports die with the hook process. Hand the toolchain
# PATH to the session itself through CLAUDE_ENV_FILE, which Claude
# Code sources when the session starts.
if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  # $PATH is written literally on purpose: it must expand when Claude
  # Code sources the env file, not when this hook runs.
  # shellcheck disable=SC2016
  printf 'export PATH=%s:$PATH\n' "$trusted_node24_dir/bin:$HOME/.cargo/bin" >>"$CLAUDE_ENV_FILE"
fi

installed_pnpm=$(pnpm --version 2>/dev/null || true)
if [[ "$installed_pnpm" != "$pnpm_version" ]]; then
  corepack disable pnpm >/dev/null 2>&1 || true
  # The trusted directory carries no npm of its own; the npm on PATH
  # belongs to the preinstalled Node, so pass --prefix explicitly to
  # install pnpm beside the trusted node (same fix as the setup
  # script's install_pnpm).
  retry npm install --global --prefix "$trusted_node24_dir" \
    --no-audit --no-fund "pnpm@${pnpm_version}"
  hash -r
fi

export npm_config_fetch_retries=5
export CARGO_NET_RETRY=5
retry pnpm --dir framerail fetch --ignore-scripts --frozen-lockfile
retry pnpm --dir install/local/wikidot-verification fetch --ignore-scripts --frozen-lockfile
retry pnpm --dir locales/typed fetch --ignore-scripts --frozen-lockfile
retry cargo fetch --locked --manifest-path deepwell/Cargo.toml
retry cargo fetch --locked --manifest-path wws/Cargo.toml
retry cargo fetch --locked --manifest-path locales/validator/Cargo.toml

if [[ ! -x /usr/local/bin/wikijump-claude-services ]]; then
  printf '/usr/local/bin/wikijump-claude-services is missing; reset the environment cache.\n' >&2
  exit 1
fi
/usr/local/bin/wikijump-claude-services
printf 'Wikijump Claude Cloud maintenance complete.\n'
