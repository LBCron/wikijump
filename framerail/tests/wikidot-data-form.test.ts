import { strict as assert } from "node:assert"
import test from "node:test"

import {
  buildWikidotDataFormState,
  serializeWikidotDataFormSource
} from "../src/lib/wikidot/wikidot-data-form.ts"

const definition = {
  default_layout: true,
  fields: [
    {
      name: "name",
      label: "Name",
      hint: "",
      field_type: "text",
      values: [],
      default_value: null
    },
    {
      name: "choice",
      label: "Choice",
      hint: "",
      field_type: "select",
      values: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" }
      ],
      default_value: "b"
    }
  ]
}

test("initial data-form state follows template order and applies select defaults", () => {
  assert.deepEqual(buildWikidotDataFormState(definition, {}), {
    name: "",
    choice: "b"
  })
})

test("a five-option select without a default starts at its first option", () => {
  const selectDefinition = {
    default_layout: true,
    fields: [
      {
        name: "choice",
        label: "Choice",
        hint: "",
        field_type: "select",
        values: ["a", "b", "c", "d", "e"].map((value) => ({
          value,
          label: value.toUpperCase()
        })),
        default_value: null
      }
    ]
  }

  assert.deepEqual(buildWikidotDataFormState(selectDefinition, {}), {
    choice: "a"
  })
})

test("empty and unselected select values serialize as Wikidot null scalars", () => {
  const selectDefinition = {
    default_layout: true,
    fields: [
      {
        name: "missing",
        label: "Missing",
        hint: "",
        field_type: "select",
        values: [],
        default_value: null
      },
      {
        name: "choice",
        label: "Choice",
        hint: "",
        field_type: "select",
        values: [{ value: "a", label: "Alpha" }],
        default_value: null
      }
    ]
  }

  const state = buildWikidotDataFormState(selectDefinition, {})
  assert.deepEqual(state, { missing: "", choice: "" })
  assert.equal(
    serializeWikidotDataFormSource(selectDefinition, state),
    "missing: null\nchoice: null"
  )
})

test("saved data-form source overrides defaults and round-trips through Wikidot source", () => {
  const state = buildWikidotDataFormState(definition, {
    name: "Probe Name",
    choice: "a"
  })
  assert.deepEqual(state, {
    name: "Probe Name",
    choice: "a"
  })
  assert.equal(
    serializeWikidotDataFormSource(definition, state),
    "name: 'Probe Name'\nchoice: a"
  )
})

test("data-form source uses Wikidot text and select scalar encoding", () => {
  const scalarDefinition = {
    default_layout: true,
    fields: [
      {
        name: "plain",
        label: "Plain",
        hint: "",
        field_type: "text",
        values: [],
        default_value: null
      },
      {
        name: "multi",
        label: "Multi",
        hint: "",
        field_type: "text",
        values: [],
        default_value: null
      },
      {
        name: "matched",
        label: "Matched",
        hint: "",
        field_type: "text",
        values: [],
        default_value: null
      },
      {
        name: "select_word",
        label: "Word",
        hint: "",
        field_type: "select",
        values: [{ value: "done", label: "Done" }],
        default_value: null
      },
      {
        name: "select_number",
        label: "Number",
        hint: "",
        field_type: "select",
        values: [{ value: "2", label: "Two" }],
        default_value: null
      }
    ]
  }

  assert.equal(
    serializeWikidotDataFormSource(scalarDefinition, {
      plain: `O'Brien: # [x] \\ slash "quote"`,
      multi: `first "quoted"\nsecond 'single' \\ end`,
      matched: "ok-42",
      select_word: "done",
      select_number: "2"
    }),
    [
      `plain: 'O''Brien: # [x] \\ slash "quote"'`,
      `multi: "first \\"quoted\\"\\nsecond 'single' \\\\ end"`,
      "matched: ok-42",
      "select_word: done",
      "select_number: '2'"
    ].join("\n")
  )
})

test("prototype-sensitive field names use only backend-provided own values", () => {
  const prototypeDefinition = {
    default_layout: true,
    fields: ["constructor", "toString", "__proto__"].map((name) => ({
      name,
      label: name,
      hint: "",
      field_type: "text",
      values: [],
      default_value: null
    }))
  }
  const state = buildWikidotDataFormState(prototypeDefinition, {})

  assert.equal(state["constructor"], "")
  // eslint-disable-next-line @typescript-eslint/unbound-method -- reading the shadowed prototype key is the point of this fixture
  assert.equal(state["toString"], "")
  assert.equal(state["__proto__"], "")
  assert.equal(
    serializeWikidotDataFormSource(prototypeDefinition, state),
    "constructor: ''\ntoString: ''\n__proto__: ''"
  )
})

test("checkbox and wiki state and source match live Wikidot", () => {
  const definition = {
    default_layout: true,
    fields: [
      {
        name: "unchecked",
        label: "Unchecked",
        hint: "ignored",
        field_type: "checkbox",
        values: [],
        default_value: null
      },
      {
        name: "checked",
        label: "Checked",
        hint: "",
        field_type: "checkbox",
        values: [],
        default_value: "1"
      },
      {
        name: "wiki",
        label: "Wiki",
        hint: "enter wiki",
        field_type: "wiki",
        values: [],
        default_value: "**Default**"
      }
    ]
  }

  const defaults = buildWikidotDataFormState(definition, {})
  assert.deepEqual(defaults, {
    unchecked: "0",
    checked: "1",
    wiki: "**Default**"
  })
  assert.equal(
    serializeWikidotDataFormSource(definition, {
      unchecked: "0",
      checked: "1",
      wiki: "**Bold**\n[[[start|Home]]]"
    }),
    ["unchecked: '0'", "checked: '1'", 'wiki: "**Bold**\\n[[[start|Home]]]"'].join("\n")
  )
})
