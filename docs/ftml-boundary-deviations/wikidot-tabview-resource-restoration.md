# Deviation: Wikidot tabview resource restoration

- Shim: `restore_wikidot_tabview_resource_compatibility` in
  `deepwell/src/services/render/compat/wikidot_compat_restore.rs`, called from
  the Wikidot render-compatibility pass.
- Reason it lives in Wikijump: Wikijump must attach the legacy Wikidot tabview
  script and initializer to the runtime page after FTML has rendered the
  delayed tabview structure. The script resource and page-runtime initialization
  depend on the served page and cannot be selected by FTML without a runtime
  resource context.
- Why FTML is not yet sufficient: the pinned FTML `Layout::Wikidot` renderer
  exposes the tabview structure but does not yet expose a typed resource and
  initializer contract for the legacy Wikidot YUI tabview runtime.
- Evidence: FTML PR #403, merged as `84e11acf30372f206a44554967b4928c4f7c3546`;
  Wikijump sandbox-oracle capture
  `/home/roku/oracle-store/wjlab/sandbox-oracle-20260807-c5-full/run-sigma-current/oracle-verdict.json`;
  the syntax-tabview row passes after the narrow generated-identity record;
  live tabview script URL observed at
  `http://d3g0gp89917ko0.cloudfront.net/v--7690939296dc/common--javascript/yahooui/tabview-min.js`.
- FTML backlog decision: keep this as bounded Wikijump-side debt while FTML
  develops a typed Wikidot tabview resource contract; do not broaden the shim
  to recognize arbitrary HTML or page content.
- Migration condition: FTML's Wikidot layout must emit the legacy tabview
  resource and initializer requirements in a typed form, with browser evidence
  covering active and inactive panels and malformed tabview boundaries; then
  this runtime restoration pass and its tests can be removed.
- Owner: Rokurolize/Wikijump maintainers.
- Review trigger: every FTML pin bump that changes tabview rendering, and any
  change to the Wikidot tabview resource or initializer contract.
