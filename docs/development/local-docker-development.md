# Local Docker development

The normal local stack is the development stack in `install/local`. It is
deliberately separate from candidate, rollback, standing-runtime, and replay
containers. Source iteration is done with the `docker-compose.dev.yaml`
override; changing a source file only reaches the existing watcher and does
not rebuild an image or reinstall dependencies.

## Deterministic toolchain

Rust is selected by `rust-toolchain.toml` (`1.99.1`). The local Rust images are
pinned to `rust:1.99.1@sha256:09027f873d45b8ecd1dc86f1fa13b7a62b875c961f017a0e331267b350430137`.
Node and pnpm are pinned to `24.22.1` and `11.10.0`; the local Node image is
`node:24.22.1-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d`.
The Rust watcher helpers are `cargo-watch 8.5.3` and `sqlx-cli 0.9.0`.
Postgres, Valkey, MinIO, and Caddy use the digest-pinned references in their
local Dockerfiles. The exact values and host tool versions are copied into
`local-docker-development-receipt.json` after each measurement run.

## Cargo profiles and caches

The repository `.cargo/config.toml` selects the shared `target/` directory.
Inside local Rust containers that path is `/src/target`, backed by the named
volume `local-rust-1-99-1-target`. Registry and Git caches use
`local-rust-1-99-1-cargo-registry` and `local-rust-1-99-1-cargo-git`. Deepwell
and WWS mount the same three volumes. No checkout `target/` directory is
mounted into a container. Promotion images build in Docker with their own
BuildKit cache mounts (`docs/development/cargo-target-policy.md`).

Normal `debug`/`test` commands use the compact profiles from
`docs/development/cargo-target-policy.md`: line tables for the local package,
no debug information for dependencies, and incremental compilation enabled.
Full symbols are opt-in:

```sh
docker compose -f install/local/docker-compose.yaml \
  -f install/local/docker-compose.dev.yaml \
  run --rm -e DEEPWELL_BUILD_PROFILE=debugging deepwell
cargo test --manifest-path deepwell/Cargo.toml --profile debugging
```

`DEEPWELL_BUILD_PROFILE` and `WWS_BUILD_PROFILE` accept only `debug`,
`debugging`, and `release`; an unsupported value exits 64. `release` is never
the default. `CARGO_BUILD_JOBS` is explicit and configurable (default `2` per
Rust service, four concurrent compiler jobs when Deepwell and WWS are both
building), which keeps the two independent watchers within the documented
16-vCPU WSL budget. Set it lower on a constrained host or raise it only with
an explicit measurement. `CARGO_INCREMENTAL=1` is retained for the normal
loop.

## Compose lifecycle and safe cleanup

Database, MinIO, and Valkey data use the separate named volumes
`local-postgres-data`, `local-minio-data`, and `local-valkey-data`. Caddy keeps
its existing named volumes. Ordinary `docker compose down` therefore removes
containers and networks while retaining all development caches and runtime
data. Never pass `--volumes` to a normal development shutdown.

For a targeted Cargo cleanup, first check leases, processes, containers, and
rollback receipts, then inspect Cargo's plan:

```sh
cargo clean --dry-run --manifest-path deepwell/Cargo.toml --profile dev
cargo clean --dry-run --manifest-path deepwell/Cargo.toml --release
```

Only an explicitly expired, unreferenced target may be removed. This procedure
must not remove any database, upload, browser-state, MinIO, standing-runtime,
or rollback volume.

## Commands and evidence

```sh
docker compose -f install/local/docker-compose.yaml \
  -f install/local/docker-compose.dev.yaml up deepwell wws framerail
docker compose -f install/local/docker-compose.yaml \
  -f install/local/docker-compose.dev.yaml run --rm deepwell \
  cargo check --manifest-path /src/deepwell/Cargo.toml
docker compose -f install/local/docker-compose.yaml \
  -f install/local/docker-compose.dev.yaml run --rm deepwell \
  cargo test --manifest-path /src/deepwell/Cargo.toml services::render::list_pages
```

The checked-in receipt records the exact Wikijump and FTML revisions, lockfile
hashes, image digests, Cargo profile, feature set, `RUSTFLAGS`, target/cache
volumes, owner and expiry, plus cold/warm checks, hot rebuild, focused-test and
restart timings, disk growth, and cache-preserving recreation evidence. A
receipt with missing measurements is not evidence that Docker development is
lightweight.

That receipt is a historical snapshot measured at revision `2b762e15`, before
the Node `24.22.1` pin, and it still records the superseded `24.18.0` stack
(`historical_snapshot` in the file). Do not read its toolchain or image entries
as current pins: those are this page and the `install/*/Dockerfile` references.
Regenerate the receipt with a fresh measurement run before citing it as
current evidence.
