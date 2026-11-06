## LOCAL docker-compose

This `docker-compose.yaml` (and corresponding `docker-compose.dev.yaml`) file are used in standing up local instances of Wikijump. The convenience script `./deploy.py` is provided to make management easier, providing options for common variations.

Before starting the stack, copy `.env.example` to the ignored `.env` file and set `DEEPWELL_RPC_TOKEN` to the output of `openssl rand -hex 32`. Deepwell requires this service token on every RPC request, and the local host publication is additionally restricted to `127.0.0.1:2747`.

Agents may use `docs/agents/local-stack-notes.md` as a small index of these requirements with common misreads (empty token, Caddy provisional config vs HTTPS, `ping` vs edge readiness).

For disposable local bulk-import runs only, `docker-compose.postgres-perf.yaml` can be layered onto the base local compose file to relax Postgres durability settings for faster writes: `docker compose -f docker-compose.yaml -f docker-compose.postgres-perf.yaml up -d`. These settings can corrupt data after a crash and are fenced to `install/local`; do not use the override with persistent, shared, or production databases.

There are two important things to note about the local tier:
1. It runs its containers in "watch mode". This means that building the service takes place after container start, not at container build time, and that if you modify local watched files, the service will rebuild and restart.
2. Which is related to the fact that several directories are instead *mapped* into the container rather than copied into it. This way, any local changes are reflected in the container.

See `docs/development.md` for more information on local deployments.

## Memory on a shared workstation

The local tier is not the deployment target, but on a workstation that runs
several stacks and agent lanes at once it is the tier whose memory is worth
watching (`docs/agents/compatibility/execution.md` describes the host memory
guard that kills the largest process under pressure). Two settings matter:

* **`FRAMERAIL_MODE`** (default `dev`) selects the Framerail entry point.
  `dev` runs the Vite dev server, which watches and recompiles the frontend;
  `built` runs `pnpm build` once at container start and then the much lighter
  `node server.ts`. Use `FRAMERAIL_MODE=built` for any work that does not
  iterate on Framerail source, for example Deepwell, WWS, corpus, or
  verification runs:
  ```sh
  FRAMERAIL_MODE=built install/local/deploy.py up
  ```
  Switch back to `dev` (or unset it) when editing the frontend, and expect the
  one-off `pnpm build` startup peak when the container starts in `built` mode.
* **`CARGO_BUILD_JOBS`** (default `2`) bounds the rustc processes inside the
  `deepwell` and `wws` containers. Keep it at 2 on a shared workstation: the
  build peaks, not steady serving, dominate this tier's memory, and every lane
  on the box shares the same CPU and memory budget. Raise it only when the
  workstation is otherwise idle.

The same reasoning is why `MALLOC_ARENA_MAX=2` and a modest
`TOKIO_WORKER_THREADS` are set in `docker-compose.yaml` for the Rust services:
glibc arenas and Tokio workers otherwise scale with the host's core count.

`scripts/measure-stack-memory.sh` prints the per-service memory numbers for a
running Compose project (cgroup current/peak, PSS, the Valkey key census, and
PostgreSQL connection counts). It only reads, so it is safe to run against a
stack other work is using:

```sh
scripts/measure-stack-memory.sh --project wikijump-local-development
```

For prebuilt/no-dev lab runtimes that still contain `cargo-watch`, use
`deepwell_hot_reload.py` to copy a Deepwell candidate into the running
container without rebuilding its image. The guarded workflow and its
limitations are documented in `docs/deepwell-container-hot-reload.md`.

## Local HTTPS certificates

The local Caddy container terminates HTTPS for `*.wikijump.dev.localhost` and `*.wjfiles.dev.localhost` on 127.0.0.1:18443 using Caddy's local certificate authority. These names identify the local development environment; the standing runtime serves `*.wikijump.localhost` on 443 (see `docs/development.md`). The Caddy data and config directories are stored in named Docker volumes:

```text
<namespace>-dev-caddy-data -> /data
<namespace>-dev-caddy-config -> /config
```

These volumes preserve `/data/caddy/pki/authorities/local/root.crt`, so restarting or recreating the local Caddy container does not rotate the local root CA and invalidate a browser trust-store entry.

If your browser reports `net::ERR_CERT_AUTHORITY_INVALID`, export the current Caddy root certificate and trust it in your operating system or browser profile. Use the same Compose project name that started the stack:

```bash
project=wikijump
caddy_container="$(docker compose -p "$project" -f docker-compose.yaml -f docker-compose.dev.yaml ps -q caddy)"
docker cp "$caddy_container:/data/caddy/pki/authorities/local/root.crt" ./caddy-local-root.crt
```

If you used a different project name, replace `wikijump` with that name. You can confirm the resolved Caddy container with:

```bash
docker compose -p "$project" -f docker-compose.yaml -f docker-compose.dev.yaml ps caddy
```

On Windows, import the certificate into the current user's trusted root store:

```powershell
Import-Certificate -FilePath .\caddy-local-root.crt -CertStoreLocation Cert:\CurrentUser\Root
```

On Linux, install it into your distribution's local CA store. For Debian and Ubuntu:

```bash
sudo cp caddy-local-root.crt /usr/local/share/ca-certificates/wikijump-caddy-local-root.crt
sudo update-ca-certificates
```

On macOS, add it to the login keychain and mark it trusted for SSL:

```bash
sudo security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db caddy-local-root.crt
```

If Caddy's local CA already rotated before this volume persistence was added, trust the newly exported `root.crt` and reload the affected browser tab. If Chrome still shows the old interstitial, close and reopen that tab or restart Chrome so it refreshes certificate verification state.
