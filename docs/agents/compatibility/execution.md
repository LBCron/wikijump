# Long-running work

## Waiting

Wait on a long build, validation, promotion, or browser campaign under a watchdog cap, not indefinitely. When the cap expires, the waiter dumps the current stage, the elapsed time, and the state of the processes it was waiting on before anything is stopped. An uncapped waiter cannot distinguish a slow stage from a hung one — a promotion once waited 64 minutes on an idle browser worker — and the dump is what makes the hang diagnosable afterwards.

## Batching

For thousands of homogeneous render or import items, use bounded batches within the known database pool. For a small tail, retry individual items. Once a failure mode is known, separate the heavy pages and retry them at low concurrency.

## Validation cadence

Develop with focused tests and validate the coherent batch once. Keep `RUSTFLAGS` stable to avoid full rebuilds. Run warnings-as-errors Clippy once per batch before pushing.

On WSL, check the user memory guard before treating a `rustc` or test SIGTERM as a product/test failure. `wsl-memory-guard.service` (`~/.config/systemd/user/wsl-memory-guard.sh`) does not cap processes by RSS; when `MemAvailable` stays below max(4 GiB, total/6) for three samples, or drops below max(2 GiB, total/12), it terminates the user's largest process. Parallel heavy Rust work across worktrees (compiles, test shards, image builds) is what triggers it, so keep concurrent heavy jobs within the VM's memory and serialize them across worktrees. Keep the guard enabled.

If an integration test fails from a missing environment or a shared-fixture race, reproduce it alone on a clean baseline before editing source.
