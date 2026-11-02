import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  attestationFileName,
  buildAttestation,
  checksFromPrChecksRun,
  landAttestation,
} from "../scripts/record-validation-attestation.mjs"

const HEAD = "a".repeat(40)
const TREE = "b".repeat(40)
const CHECKS = [
  { area: "deepwell", kind: "github-actions", reference: "https://example.invalid/run/1", conclusion: "success" },
]

test("file name binds the full head sha", () => {
  assert.equal(attestationFileName(HEAD), `attestation-${HEAD}.json`)
  assert.throws(() => attestationFileName("abc123"))
})

test("buildAttestation binds head and tree and requires entries", () => {
  const value = buildAttestation({ head: HEAD, tree: TREE, checks: CHECKS })
  assert.equal(value.schema, "wikijump.promotion_attestation.v1")
  assert.equal(value.wikijump_commit, HEAD)
  assert.equal(value.wikijump_tree, TREE)
  assert.throws(() => buildAttestation({ head: HEAD, tree: TREE, checks: [] }))
  assert.throws(() => buildAttestation({ head: HEAD, tree: TREE, checks: [{ area: "deepwell" }] }))
})

test("checksFromPrChecksRun maps successful area steps only", () => {
  const run = { url: "https://example.invalid/run/9" }
  const jobs = [
    {
      steps: [
        { name: "Deepwell targeted tests and Clippy", conclusion: "success" },
        { name: "WWS targeted tests and formatting", conclusion: "skipped" },
        { name: "Standing tooling tests", conclusion: "success" },
        { name: "Workflow policy tests", conclusion: "success" },
      ],
    },
  ]
  assert.deepEqual(checksFromPrChecksRun(run, jobs), [
    { area: "deepwell", kind: "github-actions", reference: run.url, conclusion: "success" },
    { area: "workflow", kind: "github-actions", reference: run.url, conclusion: "success" },
  ])
})

test("landAttestation is write-once and refuses conflicting content", () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "attestation-store-"))
  const value = buildAttestation({ head: HEAD, tree: TREE, checks: CHECKS })
  const first = landAttestation(store, value)
  assert.equal(first.landed, true)
  const again = landAttestation(store, value)
  assert.equal(again.landed, false)
  const different = buildAttestation({
    head: HEAD,
    tree: TREE,
    checks: [{ area: "wws", kind: "local", reference: "local run", conclusion: "success" }],
  })
  assert.throws(() => landAttestation(store, different), /already recorded/)
})
