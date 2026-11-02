# Long-term Theme Lab maintenance criteria

**Status: requirements, not current certification.** The October 7, 2026
acceptance remains an immutable historical result. It does not establish
acceptance on a newer Wikijump renderer or browser version.

## Four independent checks

1. **Upstream authority:** frozen EN/Wikidot revisions, raw source, HTML/CSS,
   assets and actual interaction evidence; record missing evidence separately.
2. **Publication inputs:** candidate JP source, exact shared dependencies,
   attachments and publication ordering, verified entirely offline.
3. **Current runtime:** source-bound built Framerail + Deepwell/FTML, pinned
   browser versions, disposable fixtures, measured action/render evidence and
   response-header identity. No Standing volume mounts or Wikidot requests.
4. **Review:** machine assertions and exact screenshot/source-intent judgments
   for changed V, C and M states; outstanding visual questions block approval.

Treat unknown evidence as **INCONCLUSIVE**, never PASS. A changed source hash,
missing screenshot, changed renderer, changed browser or failed request must
not be hidden by repinning a receipt or relaxing a threshold.

## Sustainable verification cadence (not yet fully implemented)

| Trigger | Required gate |
| --- | --- |
| PR | Source/package tests plus fresh impacted browser states; unknown dependency scope expands checks |
| Release | Current built-runtime identity, all affected visual/actions and reviews bound to the exact commit |
| Frequent scheduled checks | Smoke checks on every maintained theme and critical shared components, with missing runs flagged; frequency is chosen from change rate, failure history and observed runtime cost |
| Full campaigns | Complete 36-theme Sigma-9/Sigma-10 browser matrix across required Chromium, Firefox and WebKit widths/actions at a measured, sustainable cadence and after high-risk changes |
| Browser/EN asset/source update | Separate versioned reference refresh and explicitly reviewed impact scope |
| Recovery drill | Recreate from a clean checkout without the original worktree, local cache or Wikidot connection; cadence follows storage risk and the defined recovery objective |

Keep the existing 145 canonical obligations per theme (5,220 for 36 themes).
Separate ephemeral **capture identity** (container, image, executable, config,
ports) from **semantic impact identity** (theme CSS/source, assets, action
helpers, runtime surface and browser version). Every changed runtime needs
fresh machine observations. Previously reviewed artistic intent can be reused
only with proof that its exact question, reference, source and images are
unchanged. Unknown dependencies fail closed. Test the impact graph by changing
a single theme, a shared component, the renderer and the browser version.

`scripts/plan-change-impact.mjs` now emits a conservative read-only PR plan.
It prioritizes candidate-specific themes and known reverse includes but
requires full scope whenever source/runtime/global inputs change because the
upstream discovery graph has gaps. Narrow mandatory execution must wait for
independent proof of the complete transitive CSS, assets, components, browser
and runtime-surface dependency closure. An unknown input stays full-scope.
This planning output cannot mint or waive an acceptance receipt.

## Evidence distribution and justified retention

`scripts/content-addressed-authority-store.py` imports the independently
SHA-pinned current-head authority inventory into `objects/xx/<sha256>` under a
**separately stored directory**. Multiple paths referring to the same bytes
share one object. A source checkout is required for import only; restoring a
clean checkout checks the independently pinned manifest against its current
adaptation ledger, verifies every object and rejects unsafe paths, symlinks,
conflicts and overwrite races. The default operation is a read-only plan;
`--apply` performs bounded streaming/atomic copies. Interrupted transfers can
be rerun without invalidating already verified objects.

The object-store directory is only a local transport, **not** a backup or an
automated remote downloader. To make production retention reliable, replicate
immutable objects and the externally pinned inventory into a backed-up,
access-controlled store, with retention covering supported release histories,
the independently required upstream reference revisions, audit obligations,
and an explicit recovery window. Configure and review this policy against
actual storage cost, restore performance and risk, with periodic checksum
audits and independent restoration drills. CI should fetch
only missing hashes in a separate acquisition step; the acceptance job must
then deny external traffic. Keep versioned schema-migration tests so old
manifest/receipt formats remain interpretable.

### Explicit HTTPS acquisition and offline gate

`scripts/fetch-authority-objects.py` retrieves only missing objects using the
separately SHA-pinned inventory, from an explicitly configured HTTPS origin
serving `/objects/<first-two-hex>/<full-sha256>`. It verifies cached objects
before reuse, checks size and SHA-256 before atomic publication, rejects
redirects, credentials embedded in URLs, symlinks, invalid partial responses,
and resume-byte mismatches. Interrupted downloads have a bounded retry and
HTTP Range resume path. Secrets, when required, come from an environment
variable named by `--bearer-token-env`; never put them in URL parameters.
The default dry-run performs no requests. Loopback HTTP requires an explicit
test-only opt-in. The transport source must be backed up off-host and audited
for private/sensitive data before any publication.

After acquisition, `scripts/run-offline-authority-gate.sh
/absolute/path/to/store` reconstructs and validates the current-head evidence
inside a network namespace with no host/Internet egress, including all 36
frozen package checks and the Python regression suite. It derives the
inventory from the tracked ledger and the store, verifies every blob against
it, and reports **input integrity**, never current Sigma-9/Sigma-10
browser acceptance. The project's existing Wikidot verification GitHub
workflow is intentionally local-only. An automatic trusted CI workflow must
be connected to a real object store and supplied with sufficient disk space
and a verified network-denial mechanism before being enabled.

### Source-bound capture contract preparation

`scripts/prepare-current-runtime-contract.mjs` prepares a new, immutable,
task-namespaced Sigma-9 capture contract from the exact Framerail source and
running Deepwell's executable/image/config/source/FTML identities, after
verifying both the source mount and an explicitly required Git commit. The
`--check-only=true` path proves readiness without writing. A separate
checkout can own the actual running backend; the built sidecar's
`--runtime-repo` option selects that checkout and requires a task namespace,
so other agents' capture containers are not replaced.

The source fingerprint ignores narrowly scoped generated locale install
directories, whose pnpm symlinks and build products can change without source
changes. The actual locale inputs remain hashed and unfamiliar source
symlinks remain blocking. Every capture still probes the served runtime and
backend headers against its exact contract; contract preparation cannot itself
authorize a fresh V/C/M browser receipt.

## Certification exit test

Demonstrate repeated clean-checkout complete campaigns, including a run with no
access to the old source tree or local blob cache, using disposable task-owned
stacks. Every run must prove complete source authority, Basalt publication inputs, all 36
themes, Sigma-9/Sigma-10, required browsers, actions, visuals and cleanup.
Inject a known regression and verify it still blocks after cache restore.
Until these drills and recurring checks exist, mark the Theme Lab **not yet
operationally certified** for unattended long-term maintenance.
