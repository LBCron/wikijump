# Plan: cut Cargo build memory and time

Goal: stop parallel `rustc` jobs from exhausting RAM and swap on the 32 GB
development box. Then retire the external two-slot wrapper that serializes
every heavy build. Do it without weakening any check (`CLAUDE.md`, "Checks over
records of checks").

This is a plan. It changes no source code. Each intervention below has its own
measurement protocol and exit criterion. Nothing here is adopted on the
strength of this document alone. The retracted codegen-units change
(#2768, reverted by #2771 because its A/B came from a single noisy pair) is the
precedent this plan is written against.

Related policy: `docs/development/cargo-target-policy.md` (target directories,
profiles, cleanup), `install/standing/README.md` (promotion build),
`scripts/preflight.sh` (barrier scheduling).

---

## 1. What the repository actually builds

### 1.1 Packages and profiles

There is no Cargo workspace. `.cargo/config.toml` points every package at one
shared `target/`. The toolchain is pinned to `1.99.1` (`rust-toolchain.toml`).

| package | size | profiles (from its `Cargo.toml`) |
|---|---|---|
| `deepwell` | **one crate, 212,576 lines in `src/` (575 files)**. 4 binaries (`main.rs` and 3 in `src/bin/`). **69 integration-test crates** in `tests/` (85,767 lines; 58 of them `mod common`). Path proc-macro `deepwell-relation-impl-derive` (syn 3). | `dev`: `debug = "line-tables-only"`, deps `debug = false`, **deps `opt-level = 3`**, deepwell `opt-level = 1`, incremental (dev default). `release`: **`lto = true` (fat)**. `standing`: inherits release, `lto = false` (thin-local), **`incremental = true`**. `debugging`: full debug info. |
| `wws` | 386 packages in its graph | `dev`: same debug split, deps at `opt-level` 0. `release`: Cargo defaults (no LTO). |
| `locales/validator` | 15 packages | same compact `dev` |
| `ftml` (git dependency of deepwell) | 119,173 lines | Pulls `lightningcss =1.0.0-alpha.72` (with `rkyv` and `parcel_sourcemap`), `icu_experimental` and `icu_datetime` with `compiled_data`, and `pest_derive`. Its own profiles are ignored when built as a dependency. |

Inside Deepwell, `services/render` is **112,886 lines (53% of the crate)**. Its
largest parts are `list_pages` 27,834, `service` 21,699, `literal_regions`
13,671 and `compat` 10,654. Next come `services/view` 6,633,
`services/page_query` 5,477 and `endpoints` 10,847.

### 1.2 Dependency graph (`cargo metadata`, all platforms)

- Deepwell's graph has 575 packages; WWS's has 386. They share 219 exact
  name+version pairs.
- Deepwell's graph has **46 proc-macro crates and 86 packages with build
  scripts** (some are Windows-only and never built on Linux).
- **Native C builds, all compiled on Linux:**
  - **Both** `aws-lc-sys` (rustls' default `aws-lc-rs` provider, reached through
    reqwest, redis, sqlx-core and attohttpc) **and** `ring` (from `rust-otp`
    and rustls).
  - `libgit2-sys`, from `built`'s `git2` feature. That feature is a Deepwell
    build-dependency, but feature unification also enables it for ftml's build
    script.
  - `libz-sys`.
- **28 duplicated crate names**, including `syn`×3, `rand`/`rand_core`/
  `getrandom`×3, `hashbrown`×4, `sha1`/`sha2`/`digest`×2, `quick-xml`×2 and
  `thiserror`×2.
- **`profile.dev.package."*".opt-level = 3` also applies to proc-macros and build
  scripts.** A `package."*"` override outranks `build-override`. The rustc
  log confirms it: `syn` is built three times at opt 3, taking 22–31 s each;
  `serde_derive` takes 17.7 s, `darling_core` 18.4 s.

### 1.3 Where builds run, and how concurrently

| context | what compiles | parallelism |
|---|---|---|
| `scripts/preflight.sh --final` (jobs mode) | Wave 1: `deepwell_lint` (full-crate Clippy) beside Framerail lint/build, the verification suites and Theme Lab. Wave 2: Deepwell tests beside WWS (Clippy plus tests) and locales. | **Each Rust group has its own target dir under `PREFLIGHT_TARGET_ROOT`.** Each cargo has its own jobserver, so nothing caps the total. Build scripts and proc-macros are compiled once per target dir. |
| Deepwell test stack (`install/local/wikidot-verification/src/deepwell-integration-stack.mjs`) | `cargo build --bin deepwell` for the seed binary, then `cargo nextest run` in 12 shards (local) or 3 (CI) | **`CARGO_BUILD_JOBS` defaults to `"1"`** (lines 151 and 340). The shallow clone could not show why. |
| Standing promotion (`build-promotion-candidate-images.mjs`, `Promise.all`) | Deepwell (`standing`), WWS (`release`) and Framerail images built **side by side** in BuildKit | Docker cargo uses the default `-j` = nproc. Since #2766 the Deepwell build starts only after validation when the Deepwell group is required. |
| Local compose dev watchers | `cargo watch` in the Deepwell and WWS containers | `CARGO_BUILD_JOBS=2` each (`install/local/deepwell/Dockerfile`). They rebuild whenever sources change, competing with host builds. |
| `pr-checks.yml` (ubuntu-24.04: 4 vCPU, 16 GB) | Deepwell: fmt, `cargo test --lib`, `cargo clippy --tests`. WWS: `cargo test --all-features`. | Default `-j4`. sccache action started. |
| `consolidated-validation.yml` (nightly) | `preflight.sh --final --jobs 0`, 3 shards, `CARGO_INCREMENTAL=0` | as preflight |
| `docker-build-*.yaml` | plain `docker build` of `install/<tier>/deepwell/Dockerfile`. **prod uses the `release` profile: cold fat LTO.** | **No BuildKit cache export.** Each run starts cold. |
| external two-slot wrapper | every heavy build on the dev box | Not in this repository, so it could not be inspected. Treat it as an opaque serializer to be replaced (§3, I1). |

### 1.4 Measured so far (this session; 4 cores, 15 GB, no swap; cgroup v1)

The measurement harness is in §5 and was smoke-tested. One cold run of the
PR-check build (`cargo test --lib --no-run`, dev profile, `-j4`) was **stopped
by request after 252 of about 460 units**. It never reached the Deepwell crate,
so the most important number (the Deepwell unit's peak RSS) is **not yet
measured**. What it did show:

- Whole-build peak anonymous RSS was **788 MB** while compiling dependencies at
  `-j4`.
- The largest dependency units, all at opt-level 3: tokio 526 MB, h2 482 MB,
  syn 467 / 460 / 426 MB, zerocopy 465 MB, object 446 MB.
- Proc-macro `.so` links take about 110 MB each.
- **Conclusion:** dependency units are 0.3–0.5 GB each. Even at `-j16` they
  account for roughly 8 GB at most, which cannot exhaust 32 GB. The peaks
  that can come from this repo are the **Deepwell crate itself** (a
  212k-line single unit, compiled in several modes per cycle), **ftml**,
  **concurrent large links**, and **several cargo invocations running at
  once**. Phase 1 below confirms or refutes this first.

---

## 2. What drives peak memory (hypotheses, ranked by expected size)

For each hypothesis: the evidence so far, and the measurement that decides it.

1. **The Deepwell crate's own rustc (largest single process).**
   - Front-end memory (parse, macro expansion, type check, borrowck, MIR) scales
     with crate size, and Deepwell is one 212k-line crate. `codegen-units`,
     linker choice and debug-info level cannot lower this front-end floor.
   - The codegen phase adds roughly (parallel LLVM modules) × (module size).
     rustc takes jobserver tokens for extra codegen threads, so **cargo's
     `-j` also caps Deepwell's internal LLVM parallelism**. The current
     `CARGO_BUILD_JOBS=1` in the test stack therefore produces the
     lowest-memory but slowest possible Deepwell compile.
   - One development cycle compiles the crate in up to five distinct modes:
     - check (Clippy lib),
     - check (Clippy `--tests`),
     - dev lib,
     - dev lib `--test`,
     - `standing` or `release`.
   - Decided by: M1.
2. **Concurrency multiplier.** Preflight wave 2, promotion (`Promise.all`), the
   two compose watchers, other worktrees and agents each run their own cargo
   with its own jobserver. Peak is the **sum** of whatever large units happen
   to overlap. This is the failure the two-slot wrapper papers over.
   Decided by: M0 inventory plus M2.
3. **Integration-test linking.** 69 test crates, 4 binaries and the lib test
   each statically link Deepwell plus about 450 dependencies. That is about 74
   large links per full test build, up to `-j` of them at once. The disk
   footprint is about 74 large executables. Decided by: M3.
4. **Duplicate compiles of the biggest units (suspected, not yet verified).**
   - Resolver ≥2 activates dev-dependency features only in invocations that
     build tests.
   - `ftml` is a dev-dependency with `features = ["test-support"]`, and
     `test-support` changes ftml's code (`src/data/user_info.rs:64`).
   - So the seed-binary `cargo build --bin deepwell` and the following
     `cargo nextest run` should each compile **ftml and the Deepwell lib
     separately**, in the same target dir.
   - Decided by: M4.
5. **Incremental state for the 212k-line crate.** `dev` and `standing` load the
   previous dependency graph and query cache, which raises rustc RSS and adds
   GBs to disk. `standing` with incremental also switches rustc's default to
   256 CGUs. Decided by: M1 arms with `CARGO_INCREMENTAL=0/1`.
6. **Release fat LTO.** The whole program is merged into one LLVM module and
   optimized single-threaded. This is about 14 minutes on 16 cores
   (`install/standing/README.md`), and memory is likely the highest of any
   build. It runs only in `docker-build-*.prod` (CI) and `install/dev` today,
   not in promotion. Decided by: M6.
7. **Dependency weight.**
   - Duplicate TLS backends (`aws-lc-sys` and `ring`), libgit2 for `built`,
     28 duplicated crate names, and opt-3 proc-macros.
   - This mostly costs **time and CPU**. Each unit is small in memory.
   - Decided by: M7.

---

## 3. Interventions, ranked

The ranking is by expected peak-memory reduction relative to build-time and
risk cost. "Expected" figures are hypotheses to be confirmed by the named
measurement. None are measured results yet.

| # | intervention | peak-memory effect (expected) | build-time effect | risk | effort | gate |
|---|---|---|---|---|---|---|
| I1 | **One memory budget for all builds:** WSL limits, a cgroup memory cap per heavy build, and one shared jobserver, replacing the two-slot wrapper | **Bounds the total by construction.** It turns "swap death" into a fast, attributable OOM kill. | Neutral or better than two fixed slots: slots are sized from measured peaks, not set to 2 | low | S | M0, M2 |
| I2 | **Stop duplicate Deepwell and ftml compiles** (seed binary feature split; per-group target dirs that no longer need to differ) | Removes 1–2 whole Deepwell-crate compiles per preflight (each a multi-GB process) | **Large saving**: the Deepwell lib alone took about 200–260 s (#2768/#2771) | low | S | M4 |
| I3 | **Consolidate the 69 integration-test crates into one (or a few) test binaries** | Removes up to `-j` concurrent large links. One link replaces 69. | Large saving in link time and disk. Recompiling one test crate on any test change is the cost (measure). | medium | M | M3 |
| I4 | **Size `-j` per invocation from measured peaks**, including for the Deepwell unit itself (its LLVM threads take jobserver tokens), instead of a blanket 1 | Explicit trade-off curve; choose the knee | The test stack's `-j1` default is the slowest possible. Raising it within budget is a big win. | low | S | M1 |
| I5 | **Profile tuning per Deepwell build mode**: `codegen-units`, `incremental` for `standing`, `debug` level, `split-debuginfo` | Lowers the codegen-phase peak only; the front-end floor stays | Depends on the arm. #2771 found 256 vs 64 CGU made no wall-time difference for `standing`; memory was never measured. | low | S | M1, M5 |
| I6 | **Dev-versus-CI profile split** (`[profile.ci]`): `incremental = false`, `debug = 0`, dependency opt-level per M7 | Lower per-unit RSS and no incremental state in CI | Faster cold CI. Dev keeps incremental and line tables. | low | S | M5 |
| I7 | **CI caching that actually persists** (sccache backend; target cache) and job shaping | None per unit; fewer units compiled per run | Large CI time saving | low | S | M8 |
| I8 | **Release LTO: fat → `thin`, or keep fat LTO off the dev box entirely** | Large for release builds | Faster release builds. Possible runtime regression that must be benchmarked. | medium (runtime perf) | S | M6 |
| I9 | **Dependency hygiene**: one TLS crypto provider, drop `built/git2`, dedupe versions, compile proc-macros at opt 0 except hot runtime crates | Small per unit; fewer units | Cold-build time and CPU saving | medium (TLS provider is runtime-visible) | M | M7 |
| I10 | **Split `services/render` out of the Deepwell crate** (start with the 22,949-line self-contained subset) | **The only lever that lowers the front-end floor of the largest unit.** Expected to scale with the fraction moved. | Better pipelining and narrower incremental rebuilds; cross-crate inlining needs care | high | L | M1 rerun on the split; render benchmarks |
| I11 | **Linker choice (mold / lld / gold / bfd)** | Probably small: links are a minority of peak unless many run concurrently, and I3 removes that case | Possibly a link-time saving | low–medium (tooling distribution) | S | M3 |

### I1 — one memory budget instead of the two-slot wrapper

1. **M0 inventory first.** Record the following inside WSL:
   - `free -g`, `nproc`, the cgroup version (`stat -fc %T /sys/fs/cgroup`),
     and whether systemd is enabled;
   - `.wslconfig` `memory=` and `swap=`. WSL2 defaults to **50% of host RAM**:
     a "32 GB box" may give WSL only about 16 GB;
   - `docker info` memory, since BuildKit builds share the same VM;
   - and whether the compose watchers are running during heavy builds.
2. **Hard containment for every heavy build.** On a systemd WSL, run the build
   in a scope:

   ```sh
   systemd-run --user --scope -p MemoryMax=<budget> -p MemorySwapMax=0 -p MemoryHigh=<budget-2G> -- <cmd>
   ```

   Without systemd, use a cgroup v2 directory with `memory.max`,
   `memory.swap.max=0` and `memory.high`, plus `memory.peak` to read the
   result. Exceeding the budget then kills that build, attributable through
   `memory.events`, instead of swapping the box into unresponsiveness. The
   budget starts at about 75% of the WSL-visible RAM.
3. **One jobserver for one checkout's barrier.**
   - Cargo joins an inherited GNU make jobserver (`MAKEFLAGS=--jobserver-auth=…`).
     Run preflight's Rust groups as recipes of one `make -jN` with `+`-prefixed
     commands, or an equivalent tiny jobserver launcher.
   - Every cargo then draws from N tokens, including rustc's own extra codegen
     threads.
   - N comes from M2: N = floor((budget − largest unit's peak) / p95 unit peak) + 1.
4. **Cross-worktree and agent heavy builds.** Keep a single global gate. Make it
   a **memory-token** gate sized from M1/M2 data, not a fixed count of 2. For
   example, a Deepwell full-crate compile costs k tokens and a WWS build
   costs 1.
5. **Exit criterion:**
   - Run preflight `--final` (jobs mode), a promotion build, and both dev
     watchers rebuilding at once.
   - Every heavy build must finish inside its memory cap, with no swap use
     (`vmstat` `si`/`so` = 0) and no OOM kills.
   - Wall time must be ≤ the current two-slot wrapper's on the same commit
     (median of 3, ABAB order).
   - Only then remove the wrapper.

### I2 — remove duplicate compiles

- **Seed binary (M4).**
  - If M4 confirms two `libftml-*.rlib` and two non-test `libdeepwell-*.rlib`
    hashes in the Deepwell test target after one preflight Deepwell group, use
    the binary from the same feature set as the tests. Options:
    - build tests first (`cargo nextest run --no-run` or
      `cargo test --no-run`) and run the seeder from that invocation's
      `target/debug/deepwell`;
    - or build the seed binary with the same dev-dependency feature
      activation.
  - Do not remove `test-support`: it is test behavior.
- **Target dirs.**
  - Keep separate dirs only where groups really overlap in time; the cargo
    lock would otherwise serialize them.
  - `deepwell_lint` (wave 1) and `deepwell` (wave 2) never overlap, so a shared
    dir lets Clippy and tests share build-script and proc-macro outputs. Check
    artifacts and codegen artifacts still differ.
  - Measure before and after with the target size, unit count from
    `rustc.jsonl`, and wall time.
- **Exit criterion:** M4 shows exactly one ftml unit and one non-test Deepwell
  lib unit per preflight Deepwell group. The test verdicts must be identical.

### I3 — one integration-test binary

- **Change.**
  - Move `deepwell/tests/*.rs` under `deepwell/tests/integration/` with a
    single `main.rs` that does `mod auth; mod page; …`, and share `common` once.
  - Set `autotests = false` plus one `[[test]]`, or keep the auto-discovered
    single file.
  - Nextest still runs **each test in its own process**, so per-test isolation
    under the preflight runner is unchanged.
  - Plain `cargo test` would share one process across modules; the suite
    already requires `--test-threads 1`.
- **Risk.** Name collisions between modules, `#[path]` fixtures, tests relying
  on per-binary statics under plain `cargo test`, and the nextest partition
  hashing (`hash:i/N` is per test, so it is unaffected).
- **Exit criterion:**
  - M3 shows the link count drops from about 70 to 1–4.
  - Total link wall time, the target dir size and the full-test-build wall
    time all decrease.
  - The set of test names and their verdicts is identical; compare
    `cargo nextest list` output before and after.

### I4/I5 — Deepwell-unit settings

These can be A/B'd **without editing manifests**, using `--config`
package-scoped profile overrides. They rebuild only Deepwell, and #2771
confirmed that this fingerprint is per-package.

```sh
cargo build --manifest-path deepwell/Cargo.toml --profile standing \
  --config 'profile.standing.package.deepwell.codegen-units=16' -j 8
CARGO_INCREMENTAL=0 cargo build --manifest-path deepwell/Cargo.toml --profile standing
```

Arms for the `standing` and `dev` modes:

- `-j` ∈ {1, 2, 4, 8, 16};
- `codegen-units` ∈ {default (256 incremental / 16 non-incremental), 64, 16, 4};
- `incremental` ∈ {on, off}, both cold and warm-touch;
- `debug` ∈ {line-tables-only, 0} for dev.

Pick the knee: the lowest peak whose wall time is within 10% of the fastest
arm. Commit a profile change only with the M1 table in the PR (see §4 rules).

### I6 — dev versus CI profiles

Add `[profile.ci]` (`inherits = "dev"`, `incremental = false`, `debug = 0`, and
per-package opt-levels from M7) to `deepwell/`, `wws/` and `locales/validator`
manifests. Custom profiles are per-package because there is no workspace.

- CI uses `--profile ci`.
- Developers keep `dev` (incremental, line tables).
- Preflight stays on `dev`, so the local barrier still matches what developers
  build.
- **Gate:** M5 shows lower per-unit peak and wall time for `ci` versus `dev`
  on a cold build, and the CI test verdicts are unchanged.

### I7 — CI caching and job shaping

- **sccache persistence.**
  - Neither workflow sets `SCCACHE_GHA_ENABLED`, and nothing caches
    `~/.cache/sccache`. If so, sccache only uses the runner's local disk and
    starts cold on every run.
  - **Verify first:** add `sccache --show-stats` at the end of a run and read
    the hit rate.
  - If it is about 0, set `SCCACHE_GHA_ENABLED: "true"` (the sccache-action
    GitHub cache backend) and set `CARGO_INCREMENTAL=0` in `pr-checks.yml`.
    sccache does not cache incremental units.
  - Or replace sccache with a target-dir cache keyed on `Cargo.lock` and the
    toolchain.
- **Job shaping in `pr-checks.yml`.**
  - Deepwell's `cargo test --lib` and `cargo clippy --tests` are two full
    Deepwell-crate front-end passes in one job. Run Clippy first: it is
    cheaper and fails fast.
  - Or split them into two parallel jobs on separate runners, which halves
    per-runner peak and lowers wall time.
- **Docker image workflows.** For `docker-build-deepwell.prod`:
  - cache-mount state is not exported, so either add BuildKit
    `--cache-to/--cache-from type=gha` with a dependency-only layer, which
    matters in CI (cold every time) unlike the warm local promotion (#2768
    rejected it there);
  - or run the fat-LTO build on a larger runner.
- **Gate (M8):** compare the cache hit rate and the job wall time for 3 PRs
  touching `deepwell/**` before and after.

### I8 — release LTO

- Fat LTO only matters for `install/prod` and `install/dev` images, which are
  built in CI.
- **Minimum:** never run a fat-LTO build on the dev box. Promotion already
  uses `standing`.
- **Candidate:** `lto = "thin"` for `release`. Accept it only if the M6 memory
  and time gains come with **no render-path regression**: use
  `docs/development/render-cost-budget.md`'s benchmarks, median of ≥5, with a
  noise threshold stated in advance.

### I9 — dependency hygiene (mostly time)

1. **TLS provider.**
   - `cargo tree -e features -i aws-lc-rs` shows who enables it.
   - Moving every rustls user to `ring` (or every one to `aws-lc-rs`, and
     dropping `ring` where possible) removes a C build of several minutes of
     CPU.
   - Runtime TLS behavior changes, so this needs a security review and the TLS
     handshake tests.
2. **`built` `git2`.**
   - Deepwell's `build.rs` already takes the commit from `WIKIJUMP_GIT_COMMIT`
     for Docker.
   - Dropping the `git2` feature (or reading `git rev-parse` in `build.rs`)
     removes libgit2's C build from both build scripts.
   - Verify that `/-/about` still shows the commit (`install/standing/README.md`).
3. **Proc-macro opt-level.**
   - Replace `[profile.dev.package."*"] opt-level = 3` with named hot runtime
     crates (ftml, argon2, the hash and regex crates, lightningcss…), as
     identified by a test-suite profile.
   - Proc-macros and build scripts then fall back to `build-override`
     (opt 0).
   - The trade is cold-build seconds (syn 3× ~30 s) against proc-macro
     expansion time.
4. **Version dedupe.** Align `sha1` 0.10/0.11 between deepwell and wws (which
   share `target/`), and look at the `syn`, `rand` and `getrandom` triples.
5. **Gate (M7):** total CPU-seconds (`user_s` sum) and cold wall time drop; the
   test verdicts are identical.

### I10 — split `services/render` (only if needed after I1–I6)

Do this only if M1 shows that the Deepwell **front-end** peak (the check-mode
arm) alone still breaks the budget.

1. **First extraction.** Move the **21 render submodules (22,949 lines) that
   import nothing from Deepwell outside `services::render`** into a
   `deepwell-render-core` path crate. These are `literal_regions` 13,671,
   `include_attachment_owners` 1,559, `iftags` 1,171, `mail_form_module`
   1,030, `html_text` 919, `render_dependency` 758, and others. It is a
   mechanical move with no trait inversion.
2. **Second step.**
   - The remaining 89,937 lines (`list_pages`, `service`, `compat`,
     `runtime_modules`…) have about 250 references to `services::{page_query,
     permission, settings, …}`, `models` and `error`.
   - Extracting them needs a service-context trait or a `deepwell-core` crate
     for `models`, `types` and `error`.
   - This is a large refactor: weigh it against the measured gain from step 1.
3. **Rules.**
   - This is internal structure only: `docs/ftml-boundary.md` responsibilities
     do not move.
   - Hot cross-crate calls need `#[inline]` or the existing LTO; measure the
     render benchmarks.
4. **Gate:** M1 rerun. The Deepwell-crate check-mode and dev peaks drop;
   the sum over the two crates is ≤ before; render benchmarks show no
   regression; all tests pass.

### I11 — linker, with honest evidence requirements

- **Establish the current linker first.**
  - Rust ≥1.90 links `x86_64-unknown-linux-gnu` with the bundled `rust-lld` by
    default. That needs verifying on 1.99.1 with
    `cargo rustc --manifest-path deepwell/Cargo.toml --bin deepwell -- --print link-args`
    (look for `-fuse-ld=lld` / `gcc-ld`).
  - If lld is already in use, "switch to lld" is a no-op, and only mold
    remains as a candidate.
- **Compare on identical inputs.**
  - `linker_wrap.py` (§5) replays the same Deepwell link with each candidate
    while rustc's temporary inputs still exist (`MEASURE_LINK_COMPARE=lld,gold,mold`).
  - Use ≥5 replays per linker, on an idle box, and record peak RSS, wall and
    output size.
- **Accept only if all of the following hold:**
  - the median peak or wall improvement exceeds the range of the replays;
  - the full test suite passes with binaries from that linker;
  - the linker is available in WSL, in the CI runners and in the `rust:1.99.1`
    Docker images.
- **Ordering.** If I3 lands first, re-evaluate: with about 1 large test link
  instead of about 70, the linker choice barely matters for memory.

---

## 4. Measurement protocol (separating peak RSS from wall time)

The two quantities are measured with different instruments and reported
separately. Never infer memory from time or the reverse.

| quantity | instrument | notes |
|---|---|---|
| per-rustc peak RSS, wall, user and sys | `RUSTC_WRAPPER=rustc_wrap.py`: `wait4` `ru_maxrss`, per invocation, as JSON lines | `ru_maxrss` folds in the linker child as a max, so link-emitting units also need the linker log |
| per-link peak RSS and wall | `CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=linker_wrap.py` | can replay the same link with alternative linkers |
| whole-build concurrent peak | cgroup: v2 `memory.peak` (WSL with systemd), or v1 `memory.max_usage_in_bytes` | Both include page cache. Also sample anonymous memory (`memory.stat` `anon` on v2 / `total_rss` on v1) every 250 ms and report its max as **the** peak. |
| swap pressure | `vmstat 1` `si`/`so`, cgroup `memory.events` (`oom_kill`, `high`) | any swap-in during a run voids its time measurement |
| wall time and critical path | wall clock around the command plus `cargo build --timings` HTML | `--timings` gives unit start/end, which shows which units overlapped at the peak |

Rules, written down because of #2771:

1. **Controlled load.** Run on an idle box (1-min load < 1 before start), with
   compose watchers stopped. Record the state with `uptime` and `docker ps`.
2. **Defined cache states.**
   - **cold:** empty target, warm registry.
   - **warm-noop:** nothing changed.
   - **warm-touch:** touch one Deepwell leaf file.
   - **dep-bump:** `cargo update -p <leaf dep> --precise <next>`, reverted
     afterwards.
3. **Repeats and order.**
   - Memory arms n ≥ 3; peaks are low-variance.
   - Wall-time arms n ≥ 5, in ABAB order.
   - Report the median and the min–max range.
   - A difference counts only if the ranges don't overlap. Otherwise it is
     reported as "no difference".
4. **One variable per arm.** Use `--config` package overrides or `CARGO_*` env
   vars rather than manifest edits for exploratory arms. A manifest change is
   proposed only with the arm table attached to the PR.
5. **Results are inputs to a decision, not records.** Raw `*.jsonl` and
   `samples.tsv` stay outside the repo (scratch). The PR carries the summary
   table. Per "Checks over records of checks", no ledgers or pinned results are
   added; the harness is cheap to rerun instead.

### Measurement matrix

Run on the 32 GB WSL box (the decision box) and on a 4-vCPU/16 GB CI-shaped
host.

| id | command(s) | answers |
|---|---|---|
| M0 | inventory (I1 step 1) | real RAM, swap, cgroup and systemd availability; what else is running |
| M1 | Deepwell crate alone: warm deps, `cargo clean -p deepwell`, then build in each mode (check lib, check `--tests`, dev lib, dev `--lib --test`, `standing`), crossed with the I4/I5 arms | **the largest unit's peak and its jobs/CGU/incremental curve**; front-end floor = check-mode arm |
| M2 | `preflight.sh --final --jobs 0`, a promotion image build, and both together with the watchers on, each inside one cgroup | real concurrent peak, and which units overlapped at that moment (`--timings` plus `rustc.jsonl` start times) |
| M3 | full `cargo nextest run --no-run` (or `cargo test --no-run`) at `-j` ∈ {4, 16}, with the linker log; then the linker replay arms | link count, per-link and concurrent link peak, total link wall |
| M4 | one preflight Deepwell group; then `ls target/debug/deps/libftml-*.rlib libdeepwell-*.rlib` and a unit count from `rustc.jsonl` | whether the seed-binary feature split doubles the ftml and Deepwell compiles |
| M5 | cold `cargo test --lib --no-run` under `dev` versus a `--config`-emulated `ci` profile | dev/CI split value |
| M6 | `release` (fat) versus `lto="thin"` versus `standing`: Deepwell unit peak plus the LTO link step; render benchmarks | release LTO trade-off |
| M7 | cold full build: sum `user_s` per crate, top 20 by CPU and by RSS; before and after each hygiene change | dependency weight |
| M8 | CI: `sccache --show-stats`; job wall time across 3 PRs | CI cache efficacy |

---

## 5. Measurement harness (tested here, not committed as tooling)

The three scripts below were written and smoke-tested in this session; run A1
used them for 252 units. Proposed home if adopted: `scripts/build-measure/`,
as Wikijump-only audit tooling. That would be a separate PR, since this task is
planning only.

`rustc_wrap.py` (set as `RUSTC_WRAPPER`; logs one JSON line per real rustc
invocation to `$MEASURE_LOG`):

```python
#!/usr/bin/env python3
import json, os, sys, time
argv = sys.argv[1:]; log = os.environ.get("MEASURE_LOG")
def after(flag):
    for i, a in enumerate(argv):
        if a == flag and i + 1 < len(argv): return argv[i + 1]
cflags = {argv[i+1].partition("=")[0]: argv[i+1].partition("=")[2]
          for i, a in enumerate(argv) if a == "-C" and i + 1 < len(argv)}
start = time.monotonic(); pid = os.fork()
if pid == 0:
    try: os.execvp(argv[0], argv)
    finally: os._exit(127)
_, status, ru = os.wait4(pid, 0); wall = time.monotonic() - start
code = os.waitstatus_to_exitcode(status); name = after("--crate-name")
if log and name:  # version probes have no crate name
    with open(log, "a") as fh:
        fh.write(json.dumps({"crate": name, "type": after("--crate-type"),
            "test": "--test" in argv, "opt": cflags.get("opt-level", "0"),
            "cgu": cflags.get("codegen-units"), "debug": cflags.get("debuginfo"),
            "incr": "incremental" in cflags, "driver": os.path.basename(argv[0]),
            "maxrss_mb": round(ru.ru_maxrss / 1024, 1), "wall_s": round(wall, 2),
            "user_s": round(ru.ru_utime, 2), "start": round(start, 2),
            "exit": code}) + "\n")
sys.exit(code)
```

`linker_wrap.py` (set as the target linker):

- runs `cc "$@"` and logs peak RSS, wall and output size to `$MEASURE_LINK_LOG`;
- when `MEASURE_LINK_COMPARE=lld,gold,mold` and the output name contains
  `$MEASURE_LINK_COMPARE_MATCH`, it re-runs the identical link once per
  alternative (`-fuse-ld=<x>`, other `-fuse-ld` flags stripped, output to
  `<out>.<x>`, then deleted) while rustc's temporary inputs still exist.
- mold for the comparison: an upstream release tarball unpacked into its own
  directory and put on `PATH` (`ld.mold`).

`measure.sh <run> <cmd…>`:

- creates a child memory cgroup;
- moves the command into it, with both wrappers exported;
- samples anonymous RSS, total usage and the live compiler/linker process
  count every 250 ms;
- writes `summary.txt` with exit code, wall, the cgroup max, the sampled anon
  peak and OOM kills.

The tested version targets cgroup v1, this container's layout. On the WSL box,
use the cgroup v2 equivalent: `systemd-run --user --scope -p MemoryAccounting=yes`,
then read `memory.peak` and `memory.stat:anon` of the scope. **The v2 variant is
untested.**

---

## 6. Rollout order

1. **Phase 0 (no code change, ~half a day).**
   - Run M0, then M1 (check / dev / dev-test / standing at `-j` 4, 8, 16) and
     M2 on the dev box.
   - Run the `--print link-args` check.
   - The output is a filled-in §1.4 and a confirmed or refuted ordering of §2.
2. **Phase 1 (low risk, high value).**
   - I1: containment plus a token gate sized from Phase 0.
   - I2: seed-binary and target-dir duplicates.
   - I4: the test-stack `-j` default, set from M1.
   - I7: sccache verification and fix.
   - Exit: the I1 criterion. Then retire the two-slot wrapper.
3. **Phase 2.**
   - I3: one integration-test binary.
   - I5/I6: profile arms, then the `ci` profile.
   - I9: dependency hygiene.
   - I11 only if I3 does not make it moot.
4. **Phase 3, only if Phase 0–2 numbers still show a single unit over budget.**
   - I10 step 1 (`deepwell-render-core`), then step 2 if justified.
   - I8 when release images are next touched.

Every phase ships as normal PRs with:

- focused validation;
- the M-table for the arms that justify it;
- `scripts/preflight.sh --final` on the head;
- unchanged test names and verdicts.

---

## STATUS (2026-11-05)

**Done**
- Read the full Rust build configuration: all four manifests and their
  profiles, `.cargo/config.toml`, the toolchain pin, `cargo-target-policy.md`,
  `preflight.sh` scheduling, the Deepwell test-stack builder, the promotion
  image builder, the prod/dev/local Dockerfiles, `pr-checks.yml`,
  `consolidated-validation.yml` and the docker-build template.
- Graph analysis from `cargo metadata`: package counts, proc-macro and
  build-script inventory, native C builds and why they are pulled in, and
  duplicated crate names.
- Deepwell source sizing, and a coupling scan of `services/render` (the
  22,949-line self-contained subset).
- Prior art from PRs: #2766, #2767, #2768/#2771 (codegen-units retraction) and
  #3406 (shared preflight targets; cold Clippy 555–716 s).
- Built and smoke-tested the measurement harness: rustc wrapper, linker wrapper
  with replay comparison, cgroup runner.
- This plan: drivers, ranked interventions, measurement protocol and matrix,
  rollout.

**Partial**
- Baseline run A1 (cold `cargo test --lib --no-run`, dev, `-j4`, 4-core/15 GB
  host). It was **stopped by request after 252 of about 460 units**, before
  the Deepwell crate and before any Deepwell link. §1.4 holds what was
  captured: dependency units 0.3–0.5 GB each, an 788 MB whole-build anon peak
  over the dependency phase, and opt-3 proc-macros costing 15–31 s each. **The
  Deepwell-unit peak, the linker comparison and the 69-test link profile are
  unmeasured.**
- Hypothesis §2.4 (seed-binary feature split doubling the ftml and Deepwell
  compiles) follows from Cargo's documented resolver behavior. It is **not
  verified** (M4).
- The sccache-is-cold finding is inferred from the workflow files (no
  `SCCACHE_GHA_ENABLED`, no cache of the sccache dir). It is **not verified**
  against a run log (M8).
- The reason for the test stack's `CARGO_BUILD_JOBS=1` default is unknown;
  the clone is shallow and its history begins at #3548.

**Remains**
- Phase 0 measurements M0–M2 on the actual 32 GB WSL box. They decide the
  ordering in §2 and the token sizes in I1.
- The external two-slot wrapper itself. It is not in this repository and was
  not inspected; its replacement criteria are in I1.
- Every intervention in §3. No source, profile, workflow or script has been
  changed.
- Porting `measure.sh` to cgroup v2 / `systemd-run` and testing it on WSL.

**Summary.** The repository's memory risk is concentrated in a few places:

- one 212k-line Deepwell crate, compiled in up to five modes per cycle;
- up to about 74 large static links per full test build (69 integration-test
  crates);
- several independent cargo jobservers running at once (preflight waves,
  side-by-side promotion images, two dev watchers, other worktrees);
- fat LTO for release images.

Dependency units measured so far are small, 0.3–0.5 GB each. The fastest,
lowest-risk path is the following:

1. measure the Deepwell unit and the real concurrent peak (Phase 0);
2. replace the fixed two-slot wrapper with a cgroup-capped, memory-sized
   shared jobserver (I1);
3. delete duplicate compiles (I2);
4. collapse the integration tests into one binary (I3).

Profile and CI tuning follow. Splitting the render subsystem out of Deepwell is
the only lever that lowers the largest unit's front-end floor. It is held back
until the measurements show it is needed. Linker changes are judged only on
replayed identical-input comparisons and are likely moot after I3.
