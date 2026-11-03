# Wikidot compatibility maintenance

Wikidot compatibility work is ordinary regression work. A normal test run must not contact Wikidot, WDFiles, a third-party theme, font, or CDN origin, or depend on one developer's home directory.

## Where behavior is defined

- Product semantics live in `docs/wikidot-specifications/specifications/`, `docs/wikidot-specifications/live-observations.json`, and checked-in fixtures.
- `pnpm --dir install/local/wikidot-verification run offline:portable` is the fresh-checkout gate. It runs the oracle fixtures and the WWS, Framerail, and Deepwell suites with external networking denied.
- `pnpm --dir install/local/wikidot-verification run offline:browser` is the full-page canary against local standing. It compares SCP-9506 with a frozen Wikidot observation and replays public assets from repository-owned responses.
- Git and GitHub own current source and issue state. A new regression is a normal product bug.

## Workflow

1. Change the smallest coherent unit and add focused regression coverage.
2. Run `offline:portable`.
3. When rendered page, chrome, or theme behavior may change, also run `offline:browser`. A visually broken SCP-9506 is a regression even when coarse DOM checks pass.
4. To learn an unknown Wikidot behavior, acquire it once with the tools in `install/local/wikidot-verification/README.md`. Reduce the observation to a compact fixture and test that fixture offline from then on.
5. Never put live acquisition in CI, pre-merge commands, or a retry path. A missing frozen response fails rather than consulting Wikidot.
6. Do not approve current Wikijump output as its own golden file to make a regression pass.
7. Add cases freely. Test volume is not a reason to sample away known behavior.

## Other documents

- `evidence.md`: rules for external acquisition and browser comparison.
- `runtime.md`: candidate and standing runtime rules.
- `execution.md`: long-running work on this machine.
