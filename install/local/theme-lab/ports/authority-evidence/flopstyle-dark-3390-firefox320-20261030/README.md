# flopstyle-dark — Firefox narrow-mobile submenu probe record (#3390)

Status: bound supplementary record under LANE-ALLOCATION-35 Q3. This directory
is evidence for the successor admission of flopstyle-dark; it is NOT a gate
row and no acceptance check reads it as one.

Why a probe: the browser audit's capture tool refuses Firefox narrow-mobile
by policy (capture-interactive.mjs line 64: the 320px matrix is Chromium
only), so no Firefox 320px audit records exist. This probe measures the two
endpoint top-bar submenus directly in Firefox at 320px, with a 390px control,
using the same page setup as the phase-A diagnostic and the design harness:
the run-owned sigma10-main page on the task runtime, the production
navigation fixture markup injected, the runtime sigma stylesheet disabled,
and the acceptance styles (runtime-asset-replay.css, sigma10-offline.css,
then the candidate CSS) applied.

Contents:
- probe.mjs — the measurement script (Firefox only; settled, hover-last and
  hover-second-to-last states at 320px and 390px). Its page setup is the
  design harness's setupShellPage verbatim; the measurement records the
  phase-A result shape plus the top bar's maximum right edge.
- before-results.json — pre-fix measurements on candidate be744e1d57
  (2026-10-30, phase-A diagnostic, same m123 runtime and backend):
  second-to-last submenu escapes right by +12.58px settled and +27.58px open
  at 320px; last submenu escapes right by +37.9px settled and +52.9px open
  at 390px.
- after-results.json — post-fix measurements on candidate 4e9f17d162
  (2026-10-30, this run, same runtime and backend): both endpoint submenus
  contained (off-left 0, off-right 0) at 320px and 390px in every state.

Both result files name the runtime backend identity, the framerail
fingerprint, FRAMERAIL_ENV=prod, the candidate sha they measured, the
fixture id, and the page-setup steps. Containment is judged from element
rects; the raw document scrollWidth is reported only for reference because
an unrelated wide element (the UL.creditRate strip) inflates it.
