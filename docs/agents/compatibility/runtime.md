# Candidate and standing runtime

## Validation

Develop in the local incremental stack. Run `scripts/preflight.sh --final` on the PR head before merging. `--base` picks the comparison ref and `--groups` runs named groups regardless of the diff.

## Candidates

Use `install/local/wikidot-verification/scripts/build-promotion-candidate-images.mjs` and `start-promotion-candidate.mjs`. Candidates never publish port 443. They are disposable build outputs, so remove their containers and images when the run ends. Use `docs/development/cargo-target-policy.md` for build targets.

## Promotion

Use a normal two-parent merge, then run `install/standing/promote.py` on the merged head. It selects check groups from the Git delta, runs them through `scripts/preflight.sh`, builds from the merged head, rehearses when migrations change, and renders ahead when the saved-page generator changes. A failed canary or parity check after activation rolls standing back. Preserve the protected standing volumes.

## Saved-page freshness

Expected `compiled_generator` derives from the current FTML version and the Deepwell renderer epoch. Increment the epoch when persisted HTML semantics change so the stale-page gate can tell old output from new. Activation requires zero stale active pages.

## Cleanup

Keep the active runtime and one rollback set. Remove everything else that no running process needs. `docs/deployment/runtime-drift-policy.md` covers standing image retention.
