import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import {
  USER_INFO_TABS,
  initialUserInfoTabState,
  selectUserInfoTab,
  userInfoTabClass
} from "../src/lib/user-info-tabs.js"

const evidenceFile = new URL(
  "../../install/local/wikidot-verification/artifacts/userinfo-tab-switching-live-20261022.json",
  import.meta.url
)

const loadEvidence = async () => JSON.parse(await readFile(evidenceFile, "utf8"))

const recordedClass = (value) => (value === null ? undefined : value)

test("the tab order and labels are the retained tab markup", async () => {
  const evidence = await loadEvidence()
  const initial = evidence.states.find((state) => state.state_id === "initial")

  assert.deepEqual(
    USER_INFO_TABS.map(({ id, label }) => [id, label]),
    initial.before.tabs.map((tab) => [tab.anchor_id, tab.anchor_label])
  )
})

test("the initial state matches the retained class attributes before any click", async () => {
  const evidence = await loadEvidence()
  for (const state of evidence.states.filter((item) => item.state_id === "initial")) {
    const classes = USER_INFO_TABS.map(({ id }) =>
      userInfoTabClass(initialUserInfoTabState(), id)
    )
    assert.deepEqual(
      classes,
      state.before.tabs.map((tab) => recordedClass(tab.li_class)),
      `${state.target_id} before-click classes`
    )
  }
})

test("every recorded single-tab click yields the recorded tab classes", async () => {
  const evidence = await loadEvidence()
  const clicks = evidence.states.filter((state) => state.after !== null)
  assert.ok(clicks.length >= 12, "retained evidence covers each tab for both targets")

  for (const state of clicks) {
    const next = selectUserInfoTab(initialUserInfoTabState(), state.state_id)
    const classes = USER_INFO_TABS.map(({ id }) => userInfoTabClass(next, id))
    assert.deepEqual(
      classes,
      state.after.tabs.map((tab) => recordedClass(tab.li_class)),
      `${state.target_id} ${state.state_id} classes after the click`
    )
    assert.deepEqual(next.selected, state.state_id)
  }
})

test("re-selecting the selected tab changes nothing", () => {
  const state = initialUserInfoTabState()
  assert.equal(selectUserInfoTab(state, "ui-profile-b"), state)
})

test("recorded click sequences reproduce the tab classes at every step", async () => {
  const evidence = await loadEvidence()
  assert.ok(
    evidence.sequences.length >= 2,
    "retained evidence covers a repeated selection"
  )

  for (const sequence of evidence.sequences) {
    let state = initialUserInfoTabState()
    for (const step of sequence.steps) {
      state = selectUserInfoTab(state, step.tab_id)
      assert.deepEqual(
        USER_INFO_TABS.map(({ id }) => userInfoTabClass(state, id)),
        step.after.tabs.map((tab) => recordedClass(tab.li_class)),
        `${sequence.target_id} after ${step.tab_id}`
      )
    }
  }
})

test("selection state has no URL, relation, or request field", () => {
  const next = selectUserInfoTab(initialUserInfoTabState(), "ui-admin-b")
  assert.deepEqual(Object.keys(next).sort(), ["deselected", "selected"])
})

test("an unknown tab id is rejected", () => {
  assert.throws(
    () => selectUserInfoTab(initialUserInfoTabState(), "ui-unknown-b"),
    /Unknown user:info tab: ui-unknown-b/u
  )
})

test("the route renders the tab strip through the tested model", async () => {
  const source = await readFile(
    new URL("../src/routes/user[x+3a]info/[target]/+page.svelte", import.meta.url),
    "utf8"
  )

  assert.match(
    source,
    /import \{[\s\S]*userInfoTabClass[\s\S]*\} from "\$lib\/user-info-tabs\.js"/u
  )
  assert.match(source, /class=\{userInfoTabClass\(tabState, tab\.id\)\}/u)
  assert.match(source, /event\.preventDefault\(\)/u)
  assert.match(source, /tabState = selectUserInfoTab\(tabState, tab\.id\)/u)
  assert.doesNotMatch(source, /class:active=/u)
})
