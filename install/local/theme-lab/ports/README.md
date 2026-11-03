# SCP-EN theme ports for SCP-JP

For a new SCP-FR/SCP-KO/SCP-CN/etc. theme that is not already an accepted
package, read `NEW-FOREIGN-THEME-PORT.md` first. This file primarily documents
the completed SCP-EN campaign and its offline replay/maintenance state; it is
not the bootstrap procedure for a new foreign-branch port.

`en-theme-campaign.json` retains campaign source and historical acceptance identities. It binds all 34 refreshed SCP-EN source revisions to one local candidate package, previous JP status/source, technical-spec version, final offline Theme Lab verdict, viewport and interaction results, warnings, and receipt for each theme. `TECHNICAL-LOCALIZATION-SPEC.md` states the acceptance requirements. `en-theme-dependency-graph.json` records shared BHL/Sigma/theme/include/asset dependencies.

Each package `PORT.md` explains the port.

The fixtures intentionally contain SCP-JP's current header, top bar, sidebar, rating/evaluation modules, page options, tabs, collapsible, tables, blockquotes, images, TOC, footnotes, code, Japanese glyph probe, and shared sidebar fixture. `real-port-regression.mjs` verifies the frozen source hashes and content-addressed assets, then executes every theme plus Dear Dictator through offline Theme Lab checks, torture, interactions, four viewports, and paired screenshots.

## Future upstream maintenance

The accepted candidate is not a single upstream CSS file with incidental edits. It combines the frozen upstream page, transitive imported CSS/assets, the human JP localization baseline, and explicit SCP-JP/Wikijump acceptance overrides. Keep those origins separate when SCP-EN changes later.

Use `node ports/scripts/theme-port-maintenance.mjs audit` to inspect the current provenance and `node ports/scripts/theme-port-maintenance.mjs plan --theme=<package> --new-upstream=<file>` before rebasing a refreshed upstream source. The planner highlights selectors changed upstream that are also changed by the JP baseline or current acceptance overrides. Imported CSS must be refreshed separately even when its URL is unchanged. See `UPSTREAM-MAINTENANCE.md` for the full workflow.

Each EN package also has a `maintenance/` source set for future authoring. `base.wikidot.txt` contains the accepted page source without trailing campaign-only JP CSS modules; `jp-overrides.css` contains the canonical JP/Wikijump obligations; and deterministic generation writes the publishable page to `final.wikidot.txt`. The generator removes exact duplicate rules, repeated same-value declarations, and superseded declarations with identical at-context + selector + property keys, while retaining documented browser fallback sequences. Per-finding decisions and rationales are machine-readable in `maintenance/manifest.json`; `theme-port-maintenance.mjs audit` reports reviewed status counts and requires zero unresolved findings. The generator proves unchanged active CSS identity, ordered includes, and exact-key winners against the frozen accepted candidate. The frozen `candidate.*` files remain unchanged acceptance evidence.

`maintenance-exceptions.json` records legacy packages where retrospective provenance intentionally fails closed. An exception is a review obligation, not permission to treat today's upstream bytes as the historical source.

