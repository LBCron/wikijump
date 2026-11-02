import assert from "node:assert/strict";
import test from "node:test";

import { candidateCaseSet, candidateCaseUsage } from "../src/candidate-case-command.mjs";
import { OPEN43_CANDIDATE_DENOMINATORS } from "../src/open43-candidate-denominator-registry.mjs";
import { OPEN43_ISSUE775_CASE_IDS } from "../src/open43-issue775-edit-candidate-contract.mjs";
import { OPEN43_ISSUE777_CASE_IDS } from "../src/open43-issue777-print-candidate-case-set.mjs";
import { OPEN43_ISSUE1029_CASE_IDS } from "../src/open43-issue1029-join-candidate-case-set.mjs";
import { OPEN43_ISSUE1041_CASE_IDS } from "../src/open43-issue1041-lifecycle-candidate-case-set.mjs";
import { OPEN43_SETTINGS_BROWSER_CASE_IDS } from "../src/open43-settings-browser-candidate-contract.mjs";
import { OPEN43_SETTINGS_LIFECYCLE_CASE_IDS } from "../src/open43-settings-lifecycle-candidate-contract.mjs";
import { createOpen43SettingsLifecycleCandidateCaseSet } from "../src/open43-settings-lifecycle-candidate-case-set.mjs";

test("Open43 candidate denominators are exact, disjoint, and handoff-only", () => {
  assert.deepEqual(Object.keys(OPEN43_CANDIDATE_DENOMINATORS), [
    "settings",
    "issue775_edit",
    "issue777_print",
    "issue1029_join",
    "issue1041_lifecycle",
    "browser",
    "settings_lifecycle",
    "page_query",
  ]);
  assert.equal(OPEN43_CANDIDATE_DENOMINATORS.settings.caseIds, OPEN43_SETTINGS_BROWSER_CASE_IDS);
  assert.equal(OPEN43_CANDIDATE_DENOMINATORS.issue775_edit.caseIds, OPEN43_ISSUE775_CASE_IDS);
  assert.equal(OPEN43_CANDIDATE_DENOMINATORS.issue777_print.caseIds, OPEN43_ISSUE777_CASE_IDS);
  assert.equal(OPEN43_CANDIDATE_DENOMINATORS.issue1029_join.caseIds, OPEN43_ISSUE1029_CASE_IDS);
  assert.equal(OPEN43_CANDIDATE_DENOMINATORS.issue1041_lifecycle.caseIds, OPEN43_ISSUE1041_CASE_IDS);
  assert.equal(OPEN43_CANDIDATE_DENOMINATORS.settings_lifecycle.caseIds, OPEN43_SETTINGS_LIFECYCLE_CASE_IDS);

  assert.equal(OPEN43_CANDIDATE_DENOMINATORS.settings_lifecycle.caseIds.includes("S758_CREATE_INITIAL"), true);
  assert.equal(OPEN43_CANDIDATE_DENOMINATORS.page_query.caseIds.includes("S758_CREATE_INITIAL"), false);
  assert.equal(OPEN43_SETTINGS_BROWSER_CASE_IDS.includes("S758_CREATE_INITIAL"), false);

  const all = Object.values(OPEN43_CANDIDATE_DENOMINATORS).flatMap(({ caseIds }) => caseIds);
  assert.ok(all.length > 0);
  assert.equal(new Set(all).size, all.length);
});

test("#758 has an exact lifecycle-owner candidate adapter", async () => {
  assert.doesNotMatch(candidateCaseUsage(), /open43-(browser-surfaces|page-query-surfaces)/u);
  for (const name of ["open43-browser-surfaces", "open43-page-query-surfaces"]) {
    await assert.rejects(candidateCaseSet(name), /unknown source-owned candidate case set/u);
  }
  const registered = await candidateCaseSet("open43-settings-lifecycle");
  assert.equal(registered.id, "open43-settings-lifecycle");
  assert.deepEqual(registered.caseIds, OPEN43_SETTINGS_LIFECYCLE_CASE_IDS);
  const lifecycle = createOpen43SettingsLifecycleCandidateCaseSet();
  assert.deepEqual(lifecycle.caseIds, OPEN43_SETTINGS_LIFECYCLE_CASE_IDS);
});
