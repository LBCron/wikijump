# What each workflow is for

Every workflow here costs wall-clock time on a pull request, so each one needs a reason to exist and a trigger narrow enough that it only runs when it can actually say something. This file records both. `scripts/preflight.sh` owns the corresponding local checkpoint and final barrier.

## Pull-request validation

Pull requests are checked by `pr-checks.yml`: fast, path-scoped targeted
checks, and nothing else. It maps each changed path to the targeted checks
for the area it touches (Deepwell formatting, library tests and Clippy for
`deepwell/**`, WWS tests and formatting for `wws/**`, Framerail lint and unit
tests for `framerail/**`, the verification package suite for
`install/local/wikidot-verification/**`, the standing tooling tests for
`install/standing/**`, the workflow policy tests for `.github/**` and
`scripts/**`, a formatting check for `locales/**`) and runs only those.
That targeted evidence is the merge signal; development runs the same
targeted checks locally first and never waits on the full suite.

The full preflight barrier is informational only.
`consolidated-validation.yml` runs `scripts/preflight.sh --final` nightly on
`develop` and on manual dispatch. Nothing gates a merge on it. On the nightly
run there is no PR diff to select from, so it runs every CI-runnable group; on
dispatch it runs the diff-selected groups or the groups named in the dispatch
input. External actions in every workflow stay pinned to full commit SHAs.

`scripts/preflight.sh` remains available as a local checkpoint and is
what the informational workflow drives. It classifies working-tree and
branch changes against the selected base and runs only the path-relevant
checks. Pushes do not invoke local
validation implicitly; automatic Git hooks were removed because they can
accidentally mix unrelated uncommitted work into branch delivery.

The final form adds dependency hygiene, every selected Clippy pass, the full
test suites, the validator, and the Framerail production build. The Deepwell
suite runs as nextest partitions side by side, each on its own task-owned
stack (`WIKIJUMP_DEEPWELL_TEST_SHARDS`; a hosted runner takes fewer stacks at
once than the local box).

`full-ci.yaml` is retained only as a manual policy notice. It never runs
Playwright in GitHub Actions. Browser validation is local WSL work.

## Post-merge and deployment

`docker-build-*.yaml` build the container images per service and environment,
all delegating to `docker-build-template.yaml` so the build logic exists once.
`docker-push-silo.yaml` publishes the Silo-compatible object-storage image, and
is path-filtered to `install/local/silo/*` because nothing else can change it.

`komodo-deploy.dev.yaml` and `komodo-deploy.prod.yaml` deploy on pushes to
`develop` and `prod` respectively.

## Narrowly scoped

`wikidot-verification.yaml` is retained only as a manual policy notice. It runs
no verifier tests and performs no acquisition in GitHub Actions. Verification,
candidate cases, standing parity, and retained-evidence replay all run locally
in WSL so the identity-bound persistent response cache can be reused across
every retry. A cache hit is expected to perform zero external requests.

## Keeping triggers honest

A guard that reads a file must run when that file changes. The workflow policy
tests assert about `framerail/package.json` and `framerail/playwright.config.ts`
while living under `.github/`, so `classify-changes.mjs` carries an explicit
`WORKFLOW_POLICY_SUBJECTS` list to select the `workflow` group for them. Without
it the guard was unable to fire on the change that broke it, and the violation
surfaced on an unrelated pull request days later. If you add an assertion about
a new file outside `.github/`, add it to that list.
