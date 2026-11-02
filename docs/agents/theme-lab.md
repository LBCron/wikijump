# Theme Lab agent routing

Theme Lab is the repository-owned development harness for adapting foreign SCP
branch themes to the SCP-JP/Wikijump compatibility surface. This file is the
agent entry point. It tells you which deeper document owns the task; it is not
a replacement for those documents.

Before accepting a foreign-theme adaptation based on a Wikijump DOM, CSS, or
interaction difference, check `install/local/theme-lab/fixtures/runtime-surface-parity.json`
and `install/local/theme-lab/ports/RUNTIME-SURFACE-PARITY-AUDIT.md`. A local
candidate comparison proves only the local runtime. Treat a surface as a port
requirement only within a `PARITY_CERTIFIED` registry scope; retain and report
all other findings as quarantined until current or frozen source-side evidence
supports them. Do not let Theme Lab synthetic states certify Wikidot behavior.

## Route the request before editing

### New foreign-branch theme → SCP-JP

Examples:

- “Port FR `theme:quand-le-soleil-se-couche` to JP.”
- “Adapt this SCP-KO theme for SCP-JP.”
- “Make a local JP version of this SCP-CN theme and prove it works.”

Read, in order:

1. `install/local/theme-lab/README.md` — Theme Lab commands and the persistent
   edit/check loop.
2. `install/local/theme-lab/ports/NEW-FOREIGN-THEME-PORT.md` — source
   acquisition, package layout, dependency classification, JP adaptation and
   acceptance workflow.
3. `install/local/theme-lab/ports/TECHNICAL-LOCALIZATION-SPEC.md` — what a JP
   theme port must preserve/adapt.
4. `install/local/theme-lab/ports/SCP-JP-THEME-SURFACE-SPEC.md` — browser
   surfaces, evidence identity and review semantics.
5. `docs/agents/compatibility/evidence.md` before any live Wikidot/WDFiles/font
   acquisition.
6. `docs/local-authoring-boundary.md` before provisioning or mutating local
   authoring pages.

The completed SCP-FR example
`install/local/theme-lab/ports/quand-le-soleil-se-couche/` demonstrates this
workflow. The older SCP-KO Dear Dictator package remains useful as a
self-contained non-EN example, but it predates the generic new-port procedure.

Full Theme Lab acceptance automatically derives an **SCP-JP surface contract**
from the candidate CSS. If the theme touches the header, navigation, sidebar,
rating, credit, article, tabs, collapsibles, Interwiki or other known runtime
surface, Theme Lab exercises the corresponding real JP fixture/state instead
of assuming that a normal article screenshot covers it. It compares the same
runtime both without and with the candidate theme so responsive baseline
behavior, state-specific overflow and component interactions are attributable.
Do not hand-wave a missing surface as “probably equivalent”.

For source-specific active selectors that cannot be inferred as a standard
runtime surface, add a package `surface-contract.json`. A reviewed exception is
allowed only for a concrete, evidence-backed intentional difference and must
carry its rationale in that file. See the FR example for a theme-specific
`.flickering` heading and a reviewed source-palette difference.

### Refresh an already accepted port

Do **not** re-run the new-port workflow as if no provenance exists.

First inspect the package manifest contract.

For an SCP-EN campaign package with `en_source_sha256`, read:

1. `install/local/theme-lab/ports/UPSTREAM-MAINTENANCE.md`
2. the package's `maintenance/manifest.json`, `PORT.md`, `manifest.json`
   and receipt
3. `TECHNICAL-LOCALIZATION-SPEC.md` for any newly affected surface.

Use `theme-port-maintenance.mjs plan` before rebasing a new upstream revision.
Preserve upstream bytes, JP localization, runtime compatibility overrides and
generated acceptance artifacts as distinct layers.

For a standalone package with `schema: theme_lab_foreign_port.v1`, use the
refresh procedure at the end of `NEW-FOREIGN-THEME-PORT.md`. Do not feed that
package to the EN34 maintenance generator: reacquire the upstream source into
a staging file, compare it to the frozen package source and dependency
identities, deliberately rebase the JP adaptations, then rerun the package
build and full offline acceptance before replacing accepted evidence.

### Site-baseline migration

Changing SCP-JP's base theme (for example Sigma-9 → Sigma-10) is not a normal
single-theme port. Use the migration-owned run contract/evidence under the
relevant Theme Lab migration directory and preserve the accepted ordinary
campaign as a separate evidence dimension.

Do not infer a site migration procedure from one theme package.

For current final campaign acceptance, read
`install/local/theme-lab/ports/SEMANTIC-BROWSER-ACCEPTANCE.md`. Account for
machine facts, failures, missing authority and specific visual questions before
reviewing images. Exhaustive observations do not require exhaustive independent
visual judgments; full package and runtime/source safety gates still apply.

## Authority rules

- A foreign theme's **Wikidot source**, not its rendered HTML, is the source
  authority. **Before live acquisition, check the machine-wide shared Wikidot
  corpus first.** On the current workstation its root is
  `/home/roku/src/Rokurolize/scp-wiki-translation/corpus`; read
  `/home/roku/src/Rokurolize/scp-wiki-translation/corpus/README.md` for the
  storage/freshness contract. Normal page sources live at
  `<branch>/pages/<slug>/source.wikidot.txt`, with sibling metadata/current
  snapshot files. For example:

  - `/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:betterfootnotes/source.wikidot.txt`
  - `/home/roku/src/Rokurolize/scp-wiki-translation/corpus/jp/pages/component:betterfootnotes/source.wikidot.txt`
  - `/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/theme:basalt/source.wikidot.txt`

  The corpus is the **shared storage owner**, not an automatic freshness
  oracle. Compare its `meta.json` (`revisions`, `updated_at`), `current.json`,
  and run provenance against any later
  retained live observation already present in Theme Lab or another
  repository. When freshness is in doubt, use the local `wikidot.py` high-level
  page read as an independent live cross-check: compare `page.revisions_count`
  and `page.updated_at` with the corpus metadata (and `page.latest_revision`
  when the exact latest-revision identity matters). Raw source SHA-256 alone is
  not a sufficient ordering signal across different acquisition transports,
  because equivalent source can be serialized with different whitespace or
  line-ending bytes. If Theme Lab has a later source observation, treat that as
  evidence that the corpus page is stale and refresh the corpus slug before
  proceeding. If the required slug is present and sufficiently current for the
  task, use that retained source instead of re-fetching it into `/tmp` or
  inventing another package-local snapshot. If it is absent or demonstrably stale, use the
  acquisition owner under
  `/home/roku/src/Rokurolize/scp-wiki-translation`
  (`scripts/fetch_wikidot.py`, `scripts/corpus_sync.py`,
  `scp_wiki_wikidot/`) as appropriate to the task. That code can fall back
  to the local `wikidot.py` fork at
  `/home/roku/src/Rokurolize/wikidot.py`; its `AGENTS.md` points to
  `llms.txt`, including the direct read-only
  `site.page.get(slug).source.wiki_text` API.
- For an explicit Theme Lab evidence acquisition that is not already owned by
  the shared corpus, use
  `install/local/theme-lab/scripts/acquire_wikidot_source.py` or an equivalent
  retained source artifact. The helper performs the observed anonymous
  `viewsource/ViewSourceModule` read and records page/source identity. Do not
  let a convenient Theme Lab helper hide the fact that another repository may
  already own a fresher source snapshot.
- Rendered foreign pages are browser/reference evidence. Acquire them once
  through Theme Lab and use local replay for iteration.
- An existing SCP-JP port is evidence to inspect, not automatically the
  correctness authority.
- A port on another branch (for example SCP-KO adapting an SCP-FR theme) is
  useful cross-branch compatibility evidence. Do not copy it blindly; identify
  which changes are structural compatibility, language/site identity, and
  branch-specific policy.
- Local Wikijump output proves the candidate implementation. Wikidot remains
  the authority for Wikidot-compatible runtime behavior.

## Evidence retention (content-addressed store)

Theme Lab verification must not require one full per-candidate checkout
per evidence run. Keep a single content-addressed evidence store (see
`install/local/theme-lab/scripts/evidence-store.mjs`): each blob is
stored once under its SHA-256, per-source manifests map original
relative paths to hashes, and per-candidate views materialize as
hardlinks. `materialize` rejects manifest paths outside the destination
and existing symlinks in destination path components before writing. The
store's `verify` command re-hashes every object and confirms each manifest
resolves; run it before deleting any source copy, and never delete or
modify an evidence source until its blobs are verified in the store.

Authority evidence resolves in two roots with the same relative paths: the
checkout's `ports/authority-evidence` first, then the shared cache at
`$XDG_DATA_HOME/wikijump/theme-lab-evidence` (default
`~/.local/share/wikijump/theme-lab-evidence`; override with
`WIKIJUMP_THEME_EVIDENCE_ROOT`, empty disables). A file is accepted from the
first root whose bytes match the expected SHA-256; a missing or mismatching
local file falls back, an unsafe path never does, and a receipt's nested
artifacts are validated only against the root that resolved it. The fallback
applies only to the default checkout root; callers that pass their own root get
no fallback. Do not copy shared evidence into the checkout
(`src/evidence-roots.mjs`).

A clean checkout gets its authority evidence from the authority object store
with `install/local/theme-lab/scripts/restore-checkout-authority-evidence.sh`.
The restore inventory is derived at run time from the tracked
`adaptation-authority.json` and the store
(`scripts/derive-authority-inventory.mjs`), so an adaptation-ledger rebind
needs only the ledger change and an ingest of the new evidence into the store.
No inventory file is committed and no hash is re-pinned. See
`install/local/theme-lab/publication/CURRENT-HEAD-AUTHORITY-EVIDENCE.md`.

Once a verdict is recorded (an accept/review note with SHA references),
keep the verdict, the final package, the final run contract, and the
blobs they reference. Superseded iterations go: older canary versions,
per-day generated directories, and intermediate rebind steps (keep the
latest). Keep the accepted ordinary campaign and migration evidence as
separate dimensions over the same store, not two copies.

### Regression runs and the store (runbook)

`scripts/real-port-regression.mjs` writes run artifacts through the store
by default (#2752): each run gets `<store>/runs/<timestamp>/<package>/`
plus a `<package>.manifest.json` beside it, the run's files are ingested
into the object pool (identical captures across runs add no new blobs)
and materialized back as hardlinks, and each result row records the
ingest under `evidence_store`. The default store is
`~/.local/state/wikijump/theme-lab-store` (`THEME_LAB_EVIDENCE_STORE`
relocates it). Two escapes keep the old behaviors:
`THEME_LAB_RUN_ARTIFACT_DIR=<dir>` writes to an operator-managed
directory with no store wiring, and `--no-store` restores the historical
in-package `ports/<theme>/artifacts` default.

To inspect a stored run, read the files in its run directory directly
(they are hardlink views), or re-materialize the view anywhere with
`scripts/evidence-store.mjs materialize --manifest <run>/<package>.manifest.json --dest <dir>`.
Run `scripts/evidence-store.mjs verify` before deleting any source copy.

Audit history: the interactive visual audit keeps only active records
in `ports/interactive-visual-audit.json`. When superseded records
accumulate, run `ports/scripts/split-interactive-audit-history.mjs
--audit=ports/interactive-visual-audit.json`: it moves
`superseded_records` into `interactive-visual-audit.superseded-history/`
as hash-named JSONL shards and writes
`interactive-visual-audit.superseded-history.json`, a manifest binding
the pre-split file's SHA-256 and every shard. The active file then
carries a `superseded_history` reference instead of the records
themselves; readers resolve history through the manifest, and the
pre-split bytes remain reproducible from git plus the manifest's
recorded hash.

Retention for run directories: keep the current paired set and every run
a receipt or publication identity references. Older run *views* may be
deleted freely — keep their manifests; a view is re-materializable from
its manifest while its blobs survive. Never delete objects from
`<store>/objects` directly, and never delete a blob that any kept
manifest or receipt references; there is no garbage collector, so object
pruning is a deliberate, verified act, not a routine cleanup.

## Completion boundary

A new port is not complete when “the CSS looks approximately right.” Complete
the source/dependency package, a representative JP fixture, the offline Theme
Lab full check, required viewport/torture/interaction evidence, asset/font
proof, the automatically derived surface contract, any required package-owned
theme-specific selectors, a documented explanation for every warning, and the package
`PORT.md`/receipt. Keep public Wikidot sites read-only unless the user
explicitly authorizes publication.

If a workflow detail required to finish a port is missing from
`NEW-FOREIGN-THEME-PORT.md`, update the document in the same branch instead of
leaving the rule only in chat/session memory.
