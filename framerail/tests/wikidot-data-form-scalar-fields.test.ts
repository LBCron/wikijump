import { strict as assert } from "node:assert"
import test from "node:test"

import {
  buildWikidotDataFormPagepathLevels,
  buildWikidotDataFormState,
  getWikidotDataFormFieldPresentation,
  serializeWikidotDataFormSource,
  wikidotDataFormFieldNames,
  wikidotDataFormPagepathSelectorClass,
  wikidotDataFormUrlDisplay
} from "../src/lib/wikidot/wikidot-data-form.ts"

const field = (
  name: string,
  fieldType: string,
  configuredValue: string | null = null
) => ({
  name,
  label: `${name} label`,
  hint: "",
  field_type: fieldType,
  values: [],
  default_value: null,
  configured_value: configuredValue,
  width: 40,
  height: 1,
  match_pattern: null,
  match_error: null,
  before: "",
  after: "",
  join: false
})

test("hidden-configured-value-create ignores injected submissions", () => {
  const definition = {
    default_layout: true,
    fields: [field("scalar", "hidden", "HIDDEN_CONFIGURED_ALPHA")]
  }

  assert.deepEqual(buildWikidotDataFormState(definition, {}), {})
  assert.equal(
    serializeWikidotDataFormSource(definition, { scalar: "HIDDEN_INJECTED_CREATE" }),
    "scalar: HIDDEN_CONFIGURED_ALPHA"
  )
})

test("hidden-configured-value-edit-reload remains configured and has no control", () => {
  const hidden = field("scalar", "hidden", "HIDDEN_CONFIGURED_ALPHA")
  const definition = { default_layout: true, fields: [hidden] }

  assert.deepEqual(
    buildWikidotDataFormState(definition, { scalar: "HIDDEN_INJECTED_EDIT" }),
    {}
  )
  assert.deepEqual(getWikidotDataFormFieldPresentation(hidden), {
    control: "none",
    inputType: null,
    className: null,
    includeInFormFields: false,
    display: "text"
  })
  assert.deepEqual(wikidotDataFormFieldNames(definition), [])
})

test("file field exposes only Wikidot's observed hidden upload-state control", () => {
  const fileField = field("document", "file")
  const definition = { default_layout: true, fields: [fileField] }

  assert.deepEqual(buildWikidotDataFormState(definition, {}), { document: "" })
  assert.deepEqual(getWikidotDataFormFieldPresentation(fileField), {
    control: "file-hidden",
    inputType: null,
    className: "dataform-file-value",
    includeInFormFields: true,
    display: "text"
  })
  assert.deepEqual(wikidotDataFormFieldNames(definition), ["document"])
})

test("password-create-plaintext-source-masked-display exposes the password control contract", () => {
  const password = field("scalar", "password")
  const definition = { default_layout: true, fields: [password] }

  assert.deepEqual(buildWikidotDataFormState(definition, {}), { scalar: "" })
  assert.deepEqual(getWikidotDataFormFieldPresentation(password), {
    control: "input",
    inputType: "password",
    className: "form-control form-password",
    includeInFormFields: true,
    display: "masked"
  })
  assert.equal(
    serializeWikidotDataFormSource(definition, { scalar: "NONSECRET_PASSWORD_ALPHA" }),
    "scalar: NONSECRET_PASSWORD_ALPHA"
  )
})

test("password-edit-plaintext-reload preserves the plain editor value", () => {
  const definition = {
    default_layout: true,
    fields: [field("scalar", "password")]
  }

  assert.deepEqual(
    buildWikidotDataFormState(definition, { scalar: "NONSECRET_PASSWORD_BETA" }),
    { scalar: "NONSECRET_PASSWORD_BETA" }
  )
})

test("static-wiki-value-create-display has no override control and serializes null", () => {
  const staticField = field("scalar", "static", "STATIC **BOLD** ALPHA")
  const definition = { default_layout: true, fields: [staticField] }

  assert.deepEqual(buildWikidotDataFormState(definition, {}), {})
  assert.deepEqual(
    buildWikidotDataFormState(definition, { scalar: "STATIC_INJECTED_EDIT" }),
    {}
  )
  assert.deepEqual(getWikidotDataFormFieldPresentation(staticField), {
    control: "none",
    inputType: null,
    className: null,
    includeInFormFields: true,
    display: "wiki"
  })
  assert.deepEqual(wikidotDataFormFieldNames(definition), ["scalar"])
  assert.equal(
    serializeWikidotDataFormSource(definition, { scalar: "STATIC_INJECTED_CREATE" }),
    "null"
  )
})

test("url-default-schema-applies-to-display without rewriting storage", () => {
  const url = field("scalar", "url")
  const definition = { default_layout: true, fields: [url] }

  assert.deepEqual(getWikidotDataFormFieldPresentation(url), {
    control: "input",
    inputType: "text",
    className: "form-control form-url",
    includeInFormFields: true,
    display: "url"
  })
  assert.equal(
    serializeWikidotDataFormSource(definition, { scalar: "example.com/alpha" }),
    "scalar: example.com/alpha"
  )
  assert.deepEqual(wikidotDataFormUrlDisplay("example.com/alpha"), {
    text: "http://example.com/alpha",
    href: "http://example.com/alpha"
  })
})

test("url-explicit-ftp-schema-survives-edit while dangerous schemes fail closed", () => {
  const definition = {
    default_layout: true,
    fields: [field("scalar", "url")]
  }

  assert.deepEqual(
    buildWikidotDataFormState(definition, { scalar: "ftp://example.com/beta" }),
    { scalar: "ftp://example.com/beta" }
  )
  assert.equal(
    serializeWikidotDataFormSource(definition, { scalar: "ftp://example.com/beta" }),
    "scalar: 'ftp://example.com/beta'"
  )
  assert.deepEqual(wikidotDataFormUrlDisplay("ftp://example.com/beta"), {
    text: "ftp://example.com/beta",
    href: "ftp://example.com/beta"
  })
  // eslint-disable-next-line no-script-url -- exact unsafe input verifies fail-closed handling
  const dangerousScriptUrl = "javascript:alert(1)"
  assert.deepEqual(wikidotDataFormUrlDisplay(dangerousScriptUrl), {
    text: dangerousScriptUrl,
    href: null
  })
  assert.deepEqual(wikidotDataFormUrlDisplay("https://example.com/unobserved"), {
    text: "https://example.com/unobserved",
    href: null
  })
})

test("date fields expose options and preserve accepted and malformed submitted scalars", () => {
  const date = {
    ...field("date", "date"),
    label: "Date",
    width: 24,
    options: {
      dateFormat: "mm/dd/yy",
      showOn: "button",
      altField: "input[name=field-alt-date]",
      altFormat: "m/d/yy"
    }
  }
  const definition = { default_layout: true, fields: [date] }

  assert.deepEqual(buildWikidotDataFormState(definition, {}), { date: "" })
  assert.deepEqual(getWikidotDataFormFieldPresentation(date), {
    control: "input",
    inputType: "text",
    className: "form-control form-date",
    includeInFormFields: true,
    display: "date"
  })
  for (const value of ["1411099200", "02/29/2024", "02/29/2023", "not-a-date"]) {
    assert.equal(
      serializeWikidotDataFormSource(definition, { date: value }),
      `date: ${value}`
    )
  }
})

test("pagepath fields preserve raw fullnames while projecting the evidenced selector chain", () => {
  const pagepath = {
    ...field("origin", "pagepath"),
    label: "Origin",
    pagepath_category: "tree",
    pagepath_max_level: 3
  }
  const definition = { default_layout: true, fields: [pagepath] }
  const nodes = [
    { fullname: "tree:_root", name: "_root", parent: null },
    { fullname: "tree:alpha", name: "alpha", parent: "tree:_root" },
    { fullname: "tree:beta", name: "beta", parent: "tree:alpha" }
  ]

  assert.deepEqual(getWikidotDataFormFieldPresentation(pagepath), {
    control: "pagepath",
    inputType: null,
    className: "dataform-pagepath-chooser",
    includeInFormFields: true,
    display: "pagepath"
  })
  assert.deepEqual(buildWikidotDataFormState(definition, {}), { origin: "" })
  assert.deepEqual(buildWikidotDataFormState(definition, { origin: "tree:beta" }), {
    origin: "tree:beta"
  })
  assert.equal(
    serializeWikidotDataFormSource(definition, { origin: "tree:beta" }),
    "origin: 'tree:beta'"
  )
  assert.equal(
    serializeWikidotDataFormSource(definition, { origin: "outside:alpha" }),
    "origin: 'outside:alpha'"
  )
  assert.equal(
    wikidotDataFormPagepathSelectorClass("tree:alpha"),
    "dataform-pagepath-select-children-of-tree---alpha"
  )

  assert.deepEqual(buildWikidotDataFormPagepathLevels(pagepath, nodes, "tree:beta"), [
    {
      parent: "tree:_root",
      selected: "tree:alpha",
      options: [{ fullname: "tree:alpha", name: "alpha", parent: "tree:_root" }]
    },
    {
      parent: "tree:alpha",
      selected: "tree:beta",
      options: [{ fullname: "tree:beta", name: "beta", parent: "tree:alpha" }]
    },
    { parent: "tree:beta", selected: "", options: [] }
  ])
  assert.deepEqual(buildWikidotDataFormPagepathLevels(pagepath, nodes, "outside:alpha"), [
    {
      parent: "tree:_root",
      selected: "",
      options: [{ fullname: "tree:alpha", name: "alpha", parent: "tree:_root" }]
    }
  ])
})
