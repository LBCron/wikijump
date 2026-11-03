# Cargo target policy

This repository contains three independent Rust packages rather than one Cargo
workspace: `deepwell`, `wws`, and `locales/validator`. They keep separate lock
files and package boundaries, but they share one repository-level Cargo target
directory through `.cargo/config.toml`:

```text
wikijump/target/
```

The shared directory is the normal development cache. It prevents the same
dependency graph and compiler output from being duplicated under each package.
The package manifests keep the ordinary `dev` and `test` profiles compact by
using line-table debug information for the package under development and no
debug information for dependencies. Use the explicit `debugging` profile when
full symbols are needed:

```sh
cargo test --manifest-path deepwell/Cargo.toml --profile debugging
```

The `debugging` profile is for diagnosis, not the default development loop.
`release` remains the production profile; Deepwell keeps link-time
optimisation enabled there. Standing promotion images use Deepwell's `standing`
profile instead: release optimisation without whole-program LTO, with
incremental compilation, so a source change rebuilds in minutes.

## Candidate and rollback builds

Promotion and rehearsal images are built inside Docker by
`install/local/wikidot-verification/scripts/build-promotion-candidate-images.mjs`
(called by `install/standing/promote.py`),
never from a host `target/` directory. Their compiler state lives in BuildKit
cache mounts: the cargo registry and Git caches, and the target directories
`id=deepwell-target` and `id=wws-release-target`. Those caches are content
addressed by the build inputs; an image is identified by its image ID and the
commit, tree, and FTML labels on it, not by a target-directory path. Reclaim
them with `docker builder prune`, never by deleting Docker's storage
directories, and keep the current and rollback standing images (see
`docs/deployment/runtime-drift-policy.md`).

## Barrier target directories

`scripts/preflight.sh` runs its check groups side by side for `--final` (or any
`--jobs` other than 1). Cargo locks a target directory for the whole build, so
the Deepwell lint, WWS, and locales groups then build in their own
`target/preflight-deepwell-lint`, `target/preflight-wws`, and
`target/preflight-locales`; the Deepwell tests keep the canonical target. These
are ordinary per-checkout targets: the standing promotion's persistent
checkout keeps them warm between promotions, and `cargo clean` with the
matching `--target-dir` reclaims them.

## Safe cleanup

Before cleanup, verify that no `cargo`, `rustc`, candidate builder, or lease is
using the target. Inspect the effect first:

```sh
cargo clean --dry-run --manifest-path deepwell/Cargo.toml --profile dev
cargo clean --dry-run --manifest-path deepwell/Cargo.toml --release
```

Apply cleanup only to the canonical target or to an explicitly identified,
expired candidate target. Do not use a broad filesystem deletion to reclaim
space, and do not delete a runtime volume as part of this procedure.

This policy follows Cargo's documented target-directory, profile, build-cache,
and `cargo clean` controls:

- <https://doc.rust-lang.org/cargo/reference/workspaces.html>
- <https://doc.rust-lang.org/cargo/reference/config.html>
- <https://doc.rust-lang.org/cargo/reference/profiles.html>
- <https://doc.rust-lang.org/cargo/reference/build-cache.html>
- <https://doc.rust-lang.org/cargo/commands/cargo-clean.html>
- <https://doc.rust-lang.org/cargo/guide/build-performance.html>
