# Claude Code cloud sessions

How Wikijump is set up for Claude Code cloud sessions (Anthropic-hosted
environments).

## Environment (created once per account, at claude.ai/code)

- **Name:** `wikijump`
- **Network access:** Trusted (covers npm, PyPI, crates.io, Docker Hub,
  GitHub). Use Custom and add `*.wikidot.com` only for sessions that
  must fetch live Wikidot evidence.
- **Environment variables:**
  ```
  BASH_DEFAULT_TIMEOUT_MS=600000
  BASH_MAX_TIMEOUT_MS=1800000
  ```
- **Setup script:** the contents of `scripts/claude-cloud-setup.sh`.
  It installs Node 24, Rust 1.99.1 and pnpm 11.10.0, installs the
  `/usr/local/bin/wikijump-claude-services` helper, and prefetches the
  pnpm and cargo dependencies so the environment snapshot starts warm.
- **Network secrets:** none. GitHub traffic goes through the session
  proxy; never place a token in environment variables.

One-time account steps in a terminal: run `claude`, then
`/claim-credit` (if a cloud-session credit is offered) and
`/web-setup` (connects GitHub and creates the Default environment).

## Per-session behavior

`.claude/settings.json` registers a SessionStart hook that runs
`scripts/claude-cloud-maintenance.sh`. The hook no-ops outside cloud
sessions (`CLAUDE_CODE_REMOTE` is not `true`), so local machines are
never touched. In the cloud it hands the pinned toolchain PATH to the
session through `CLAUDE_ENV_FILE` (a hook's own exports do not reach
the session), refreshes dependency prefetches, and starts
PostgreSQL/Redis through the services helper (the environment
snapshot restores files, not processes). The helper creates the
`wikijump_claude` database only if it is missing and never wipes
state, so a resumed session keeps its data.

## Working rules in cloud sessions

- GitHub operations go through a proxy. `gh pr` and `gh issue` use
  GraphQL and are rejected there; use the built-in GitHub tools or
  `gh api` (REST).
- The VM is 4 vCPU / 16 GB / 30 GB. Run focused validations sized for
  it. The full preflight, consolidated validation, and Standing
  promotion stay on the WSL workstation.
- Everything else in `CLAUDE.md` applies unchanged, including normal
  merges only, the Standing volume protections, and the rule that
  Claude Code opens PRs but does not merge them.

## Model selection (operator policy)

Use only the current 5.5 family: Haiku 5.5 with low effort for
mechanical work, Sonnet 5.5 with medium effort as the default, and
Opus 5.5 with high effort only for genuinely hard design or
debugging. Do not select older model generations.
