# New foreign SCP theme → SCP-JP

This is the generic procedure for starting a Theme Lab port from a foreign SCP
branch. It exists so a coding agent can execute a request such as:

> Port SCP-FR `theme:quand-le-soleil-se-couche` for SCP-JP.

without relying on prior-session memory.

The worked repository example is
`ports/quand-le-soleil-se-couche/`.

## 1. Establish source authority

Read `docs/agents/compatibility/evidence.md` before live acquisition.

Do not reconstruct the theme source from rendered HTML.

Before fetching anything live, check the shared Wikidot corpus owned by
`/home/roku/src/Rokurolize/scp-wiki-translation`. Read
`/home/roku/src/Rokurolize/scp-wiki-translation/corpus/README.md` first. On
this workstation the shared corpus root is:

```text
/home/roku/src/Rokurolize/scp-wiki-translation/corpus
```

The normal source path is:

```text
<branch>/pages/<slug>/source.wikidot.txt
```

Inspect sibling `meta.json` (`revisions`, `updated_at`), `current.json`, and the
corpus run provenance before deciding whether the retained page is fresh enough
for the port. The
corpus is the shared storage owner, **not a guarantee that its bytes are the
newest observation on the machine**. Compare it with any later retained live
observation already present in Theme Lab or another repository. If such an
observation is newer, refresh that slug into the shared corpus first; do not
declare the older corpus snapshot authoritative merely because it is in the
corpus, and do not continue indefinitely from the newer ad-hoc copy either.
This applies to dependencies and components as well as the top-level theme: for
example, an EN/JP component comparison should first inspect
`corpus/en/pages/component:<slug>/` and
`corpus/jp/pages/component:<slug>/`.

When two retained copies disagree and their ordering is not obvious, perform a
read-only live cross-check with the repository-pinned `wikidot.py` client.
Compare `page.revisions_count` and `page.updated_at` against `meta.json`; use
`page.latest_revision` when the exact latest revision needs confirmation. Do
not infer which copy is newer from SHA-256 alone. Different acquisition paths
can preserve the same Wikidot revision with harmless whitespace/line-ending
serialization differences, while revision count and edit timestamp identify
the actual Wikidot page state.

If the corpus does not contain a sufficiently current source, prefer the
repository-owned acquisition tooling under
`/home/roku/src/Rokurolize/scp-wiki-translation`
(`scripts/fetch_wikidot.py`, `scripts/corpus_sync.py`,
`scp_wiki_wikidot/`) when the result belongs in the shared corpus. Its
direct/Ajax fallback is the local `wikidot.py` checkout at
`/home/roku/src/Rokurolize/wikidot.py`; read that checkout's `AGENTS.md`
and `llms.txt` rather than reimplementing Wikidot page-source access.

For a targeted stale page, `corpus_sync.py --slug <fullname>` is the
repository-owned repair path. `--slug` is a page-core targeted repair and is
not combined with the `xmlrpc-complete` profile. Use the transport appropriate
to the site/runtime contract; `--transport fallback` uses the Wikidot Ajax
client and does not require XML-RPC credentials.

For a Theme-Lab-owned one-off evidence snapshot, fetch the public page source
through Wikidot's observed anonymous ViewSource boundary:

```sh
python3 install/local/theme-lab/scripts/acquire_wikidot_source.py \
  --url 'https://<branch>.wikidot.com/theme:<slug>' \
  --output /tmp/<slug>.wikidot.txt \
  --metadata /tmp/<slug>.source.json
```

The helper:

1. GETs the explicit public `*.wikidot.com` page;
2. reads `WIKIREQUEST.info.pageId`;
3. retains the anonymous `wikidot_token7` cookie;
4. POSTs `viewsource/ViewSourceModule` with the page ID and token;
5. writes source text plus page/site/revision/update/hash metadata.

This is an explicit evidence acquisition helper, not a regression command.
The output and metadata pair are cache-first: rerunning the same command
validates and reuses those retained bytes without a network request. Use
`--refresh` only when you intentionally need a new live source revision. A
live acquisition writes a durable `.acquiring` barrier first; if acquisition
fails, later runs fail closed until that barrier is inspected rather than
silently refetching. Freeze the acquired source in the package and use that
frozen copy thereafter.

Record at least:

- branch/site and canonical URL;
- page ID;
- source revision/update time when exposed;
- exact source SHA-256;
- acquisition date/intent.

If source acquisition is unavailable, do not substitute current rendered HTML
and call it source provenance.

## 2. Inspect existing JP and other-branch implementations

Before inventing compatibility CSS:

- search for an existing SCP-JP theme or article already using the theme;
- inspect its exact source when public;
- inspect another branch's port when one is relevant.

These are **evidence, not authority**. Classify each difference:

- source-language/site identity;
- cross-branch DOM/theme-framework compatibility;
- branch-local component/include replacement;
- asset hosting;
- typography/local-language adaptation;
- actual bug repair.

Worked example: the FR “Quand le Soleil se Couche” source defines `ct_*`
variables that the FR site framework consumes. SCP-KO already demonstrated a
cross-branch Sigma-9 mapping from those variables to stock header/link DOM.
The JP port reuses that evidenced structural mapping, but replaces Korean
`재단` with JP `財団`. The current SCP-JP hub is also important evidence: it
currently includes the KO theme and explicitly notes that the raw FR include
does not work normally under the JP site environment.

## 3. Walk includes and dependencies before editing

Inventory:

- `[[include]]` edges;
- `[[module CSS]]` and imported CSS;
- fonts;
- images/backgrounds/icons;
- `local--files` and `local--code`;
- variables supplied through `[[include ... |name=value]]`;
- branch-specific components used only to render the theme's documentation
  page.

Do not assume every include is a runtime dependency.

For an include guarded so it renders only on the theme/showcase page, replace
it with a local JP demonstration fixture instead of shipping a foreign
showcase framework in the reusable theme. In the worked FR case,
`component:modele-theme` delegates to `component:modele-theme-base`, whose
showcase body is inside `[[iftags +thème]]`; it is therefore evidence for what
the source page demonstrates, not a dependency required by an article using
the theme.

Classify every runtime external resource with the same vocabulary used by
`TECHNICAL-LOCALIZATION-SPEC.md`: retain shared upstream, replace with a
public JP counterpart, localize into the package, replace with JP-owned asset,
or remove as obsolete. Record exact digests.

## 4. Separate publish template from injected validation CSS

Wikidot include variables such as `{$sous-titre}` are substituted by the
Wikidot include renderer. Theme Lab's direct stylesheet injection is not that
renderer.

Therefore a variable-bearing theme SHOULD keep two explicit forms:

- a **publish template**, preserving the actual include parameter contract;
- a **validation CSS** copy where each required include variable has a
  representative concrete value.

Never conclude that a theme variable is broken merely because raw
`{$variable}` was injected as ordinary CSS.

The worked FR package uses:

- `candidate-template.css` — preserves `{$sous-titre}`;
- `candidate.css` — substitutes `夜明けまで忘れるな` for deterministic
  Theme Lab validation.

Keep the parameter name compatible with already published JP documentation
unless there is evidence to migrate callers.

## 5. Keep local verification assets local; make publication assets explicit

For the edit loop, keep candidate assets under the package and pass
`--asset-dir`. Theme Lab injects verified local bytes into the browser copy.

Do not confuse that with the eventual Wikidot publication layout. A
publishable theme should normally reference named attachments on its planned
JP theme page rather than embedding hundreds of kilobytes of data URIs.

The package build may therefore emit:

- a self-contained local/demo source for deterministic verification;
- a publishable theme source referencing the exact named attachments that
  must be uploaded alongside it.

The attachment files and SHA-256 values remain part of the package.

## 6. Build a representative JP fixture

Do not compare only an empty page. Exercise every source-specific surface the
theme modifies. Typical fixture content includes:

- rating/credit where applicable;
- links and visited/new link behavior;
- all heading levels the source touches;
- tabs and collapsibles;
- tables/blockquote/code;
- image blocks;
- footnotes;
- Japanese text long enough to expose wrapping/font fallback;
- source-specific classes and pseudo-elements.

Add source-specific selectors to `acceptance-selectors.txt`. The shared
runtime selectors are not proof that a theme's own rules survived.

## 7. Start one persistent Theme Lab session

Recover the actual local runtime/credential state first; do not invent a new
credential contract.

Example:

```sh
export DEEPWELL_RPC_TOKEN=...   # recover privately from the authorized local runtime

node install/local/theme-lab/scripts/theme-lab.mjs serve \
  --socket /tmp/theme-lab-<slug>.sock \
  --candidate-url https://scpaiueouiuiuiui.wikijump.localhost:18443/boundary-check \
  --asset-dir install/local/theme-lab/ports/<slug>/assets \
  --sidebar-html install/local/theme-lab/ports/<slug>/sidebar-preview.html \
  --browser-root framerail \
  --browser-executable /usr/bin/google-chrome
```

Use the same daemon while iterating.

## 8. Acquire the rendered reference once

The first reference check may perform the explicit external acquisition:

```sh
node install/local/theme-lab/scripts/theme-lab.mjs check \
  --socket /tmp/theme-lab-<slug>.sock \
  --site-id 6000003 \
  --wikitext install/local/theme-lab/ports/<slug>/candidate.wikidot.txt \
  --css install/local/theme-lab/ports/<slug>/candidate.css \
  --reference https://<branch>.wikidot.com/theme:<slug> \
  --selectors install/local/theme-lab/ports/<slug>/acceptance-selectors.txt \
  --compact
```

Theme Lab stores the reference and its dependencies content-addressed. After
that successful acquisition, normal edits use `--offline`.

Third-party requests made by the reference page itself may be unavailable or
blocked; distinguish optional reference failures from resources required by
the candidate.

## 9. Iterate on evidence, not visual guesswork

Use:

```sh
node install/local/theme-lab/scripts/theme-lab.mjs check ... --offline --iteration
```

for the fast loop. Fix only evidence-backed issues:

- missing selectors/components;
- new horizontal overflow;
- inactive media rules;
- wrong cascade winner;
- missing candidate asset;
- unreadable/fallback Japanese typography;
- failed interaction states.

`new horizontal overflow` means overflow introduced or worsened by the theme
relative to the same SCP-JP target DOM/state without the candidate theme
layers. An equal or worse overflow already present in that target baseline is
not evidence that the port introduced a defect and cannot by itself authorize
a theme-specific correction. Keep the inherited target issue visible in the
diagnostics and repair the runtime/component separately when that is the real
owner. If the theme does worsen the target baseline, fix and certify the
theme-added regression; do not infer causality merely because a candidate-only
CSS patch can make the shared target defect disappear.

For SCP-JP navigation, longer Japanese labels frequently expose submenu
min-content/positioning problems that do not appear on the source branch.
`TECHNICAL-LOCALIZATION-SPEC.md` defines expanded navigation geometry as an
adaptation surface. Constrain menu/list/link widths and allow wrapping rather
than hiding or clipping the menu.

Do not assume that a selector seen in the candidate CSS is covered merely
because the ordinary fixture renders without obvious damage. Full `check`
automatically maps known selectors onto the SCP-JP surface contract and uses
the repository-owned JP component fixture to exercise the applicable state.
This is intentionally independent of palette and branch: a theme that touches
`.creditButton`, for example, is checked against the real credit component;
one that touches `.mobile-top-bar` is checked with the submenu expanded.

If the source theme has an active selector that is not a standard runtime
surface, add `surface-contract.json` to the package. Example:

```json
{
  "schema": "theme_lab_surface_contract.v1",
  "strict": true,
  "custom_selectors": [
    {
      "id": "theme.special-heading",
      "selector": "h2 .special-heading",
      "viewports": ["desktop", "mobile"],
      "reason": "The source showcase uses this class as an active themed heading."
    }
  ]
}
```

Every listed selector must actually exist at each requested viewport in the
candidate fixture or final acceptance fails. If automation intentionally
surfaces a difference it cannot decide (for example text color over a source
theme image), bind the exact `kind`/surface/selector to
`reviewed_exceptions` with an evidence-backed rationale. Do not use reviewed
exceptions to suppress an interaction, overflow, missing fixture, or otherwise
actionable defect.

Do not chase raw full-page RMSE between two different-language theme showcase
documents. It is diagnostic evidence. Browser geometry, source-specific
selectors, component identity, interactions, assets/fonts, and manual paired
visual review establish acceptance.

## 10. Run the full offline acceptance

Before calling the port complete, run the ordinary full check (not
`--iteration`) in offline mode with visual artifacts:

```sh
node install/local/theme-lab/scripts/theme-lab.mjs check \
  --socket /tmp/theme-lab-<slug>.sock \
  --site-id 6000003 \
  --wikitext install/local/theme-lab/ports/<slug>/candidate.wikidot.txt \
  --css install/local/theme-lab/ports/<slug>/candidate.css \
  --reference https://<branch>.wikidot.com/theme:<slug> \
  --offline \
  --selectors install/local/theme-lab/ports/<slug>/acceptance-selectors.txt \
  --visual \
  --artifact-dir install/local/theme-lab/ports/<slug>/artifacts \
  --surface-contract install/local/theme-lab/ports/<slug>/surface-contract.json \
  --compact
```

Omit the last option when the package has no theme-specific contract; known
SCP-JP surfaces are still auto-discovered and tested by default.

Acceptance requires `overall_acceptance.status` (also exposed as the public
`verdict`) to be `pass`, or `warn` with every warning explained. A separate port
pass never overrides a failed local target. Inconclusive results are incomplete;
CLI exit codes 1 and 2 must stop completion. Keep both diagnostic dimensions.

Source CSS is preserved; local Wikijump observations and synthetic fixture/image reviews
cannot create publishable CSS. Freeze real source/target A/B evidence before
adding a target correction. Check all submenu/link left and right bounds at
320px and 390px, in addition to document width. Sigma-9 and Sigma-10 credit
contracts must remain distinct. A changed candidate invalidates its old visual
acceptance unless exact identity reuse is proven.

Acceptance also requires:

- no evidence-backed errors or unexplained `next_actions`;
- all required viewport overflow checks pass;
- torture corpus passes;
- relevant interactions pass;
- all touched SCP-JP runtime surfaces have applicable-state coverage and no
  unexplained surface-contract issue;
- source-specific active selectors required by `surface-contract.json` are
  present at their declared viewports;
- required candidate assets present;
- no external acquisition during the offline run;
- Japanese font/wrapping behavior recorded;
- every warning explained as a concrete non-defect or repaired.

Stop the daemon after the run.

## 11. Preserve the package as reproducible evidence

At minimum keep:

```text
ports/<slug>/
  PORT.md
  manifest.json
  upstream-<branch>.wikidot.txt
  candidate-template.css       # when include variables exist
  candidate.css                # concrete validation CSS
  candidate.wikidot.txt        # representative JP fixture
  theme-shell.wikidot.txt      # reusable/publishable source wrapper
  acceptance-selectors.txt
  surface-contract.json         # when source-specific active selectors/reviews exist
  build.mjs                    # when build/materialization is required
  assets/
```

Additional source/include/cross-branch snapshots belong in the package when
they materially explain a decision.

Standalone foreign-port manifests use their own schema and are intentionally
not auto-discovered by `theme-port-maintenance.mjs`, which selects manifests carrying the EN campaign's
`en_source_sha256` contract. If a standalone port later adopts that
maintenance model, migrate it deliberately rather than making a generic
`manifest.json` silently enter the EN campaign.

`PORT.md` must explain:

- source identity and credits;
- existing JP/cross-branch evidence;
- every material JP adaptation and why it exists;
- dependency/asset decisions;
- first actionable Theme Lab finding and its repair, when any;
- final viewport/torture/interaction/font/asset result;
- warnings/non-defects;
- how to build the publishable source and which attachments it requires.

## 12. Publication is a separate authority boundary

Creating and validating a JP port in this repository does not authorize
editing `scp-jp.wikidot.com`. Keep real branch sites read-only unless the user
explicitly requests and authorizes publication.

If publication is later authorized, publish exactly the reviewed source and
named attachments. Do not silently substitute a newly fetched upstream revision.

## 13. Refresh a standalone foreign-port package later

`theme_lab_foreign_port.v1` packages are deliberately not discovered by the
historical SCP-EN maintenance generator. That generator owns the EN34
`en_source_sha256` / `maintenance/` contract and must not reinterpret a
standalone FR/KO/CN package merely because it also contains `manifest.json`.

For a later upstream refresh:

1. acquire the new upstream source into a staging file with
   `acquire_wikidot_source.py`; do not overwrite the frozen source first;
2. compare its source hash and source text with the package's frozen upstream
   snapshot;
3. refresh material include/dependency source snapshots and named assets
   separately, because an unchanged page can still reference changed bytes;
4. review each existing JP adaptation against the changed upstream rules and
   preserve/remove it only with evidence;
5. update the package manifest/source snapshot only after that review;
6. rebuild the publishable source and prove it is deterministic;
7. run focused Theme Lab checks for changed surfaces, then the complete
   offline acceptance and manual paired visual review;

If this workflow becomes common enough to automate, add a standalone-port
planner rather than weakening the EN maintenance manifest guard.

## Campaign closure

Source integrity, deterministic generation, and adaptation authority do not
substitute for current browser acceptance. Finish the full port check with exact
paired image review and the applicable interaction matrix. Unreviewed visual
results are inconclusive even when raw pixel comparison succeeds. A separate
`candidate-base.css` must be included with `--css-base`.

