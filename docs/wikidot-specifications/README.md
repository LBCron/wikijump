# Wikidot feature specifications

This directory is an exhaustive, documentation-derived implementation inventory for the frozen Wikidot corpus at `~/src/Rokurolize/scp-wiki-translation/corpus/www/pages`.

- `catalog.json` is the authoritative machine-readable feature index.
- `CATALOG.md` is the human-readable index.
- `DETAILED_SOURCE_GAP_SPECIFICATIONS.md` is the human-readable library of the 57 features hardened in the 2026-08-16 source-gap snapshot, linking directly to each normative P1-P8 specification. It is not the live work queue.
- `source-coverage.json` proves that all 1,806 corpus pages were enumerated and classified, while listing only non-user pages individually.
- `live-observations.json` records reproducible live-Wikidot corrections that override conflicting or incomplete corpus claims.
- `detailed-feature-contracts.json` is the machine-readable P1-P8 contract set for the 57 features hardened in that snapshot against current Wikidot evidence.
- `detailed-spec-evidence-20260816.json` seals the documentation, live Wikidot, and retained evidence used by those detailed contracts without storing credentials or private message content.
- `specifications/` contains exactly one English Markdown specification for every catalog item.

## Interpretation rules

1. A corpus page is not automatically a feature. The 1,560 `community-sites:*` pages are user-submitted application records, not compatibility evidence. They are excluded from specifications and individual coverage entries; coverage keeps only an aggregate count, byte total, and inventory digest.
2. Redirects, indexes, navigation fragments, marketing repetitions, policies, and runtime composition pages are retained in `source-coverage.json`; relevant pages are attached to canonical feature specs as supporting evidence.
3. Every normative source extract retains its exact corpus page, original line numbers, and complete-file SHA-256.
4. Documentation status matters. `invocation-only`, `high-level-documentation`, and `partially-documented` specs identify real features but do not authorize invented behavior.
5. This snapshot is a specification-discovery input. When a reproducible live Wikidot observation conflicts with it, record both and implement live behavior.
6. A specification marked `detailed-p1-p8` has explicit normative coverage for all P1-P8 axes. A fail-closed statement in that section is an intentional compatibility boundary, not permission to infer the missing behavior from local output.

Set `WIKIDOT_DOCUMENTATION_CORPUS` only when regenerating from a different checkout of the same corpus layout.
