import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"

const fixtureUrl = new URL("../fixtures/simpletodo-mutation-evidence-fixture.json", import.meta.url)
const artifactUrl = new URL("../artifacts/simpletodo-mutation-live-20260810.json", import.meta.url)
const captureScriptSha256 = "6b4a0b910a5f522a1919faa8feec3593d679c3c1c1f1a0d8ab1a0acf5a72feb7"

const sha256 = (value) => createHash("sha256").update(value).digest("hex")

test("the frozen SimpleToDo mutation authority artifact is bounded and non-closing", async () => {
  const fixtureBytes = await readFile(fixtureUrl)
  const artifact = JSON.parse(await readFile(artifactUrl, "utf8"))
  const fixture = JSON.parse(fixtureBytes)

  assert.equal(artifact.schema, "wikijump.wikidot.simpletodo-mutation-evidence.v1")
  assert.equal(artifact.lane_id, fixture.lane_id)
  assert.deepEqual(artifact.surface_ids, fixture.surface_ids)
  assert.equal(artifact.run_id, fixture.run_id)
  assert.equal(artifact.site, fixture.site)
  assert.equal(artifact.status, "blocked")
  assert.equal(artifact.closure, "not_closed")
  assert.equal(artifact.fixture_sha256, sha256(fixtureBytes))
  assert.equal(artifact.script_sha256, captureScriptSha256)
  assert.equal(artifact.mutation_attempt_count, 0)
  assert.equal(artifact.run_task_count_created, 0)
  assert.equal(artifact.unexpected_duplicate_count, 0)
  assert.equal(artifact.cleanup_status, "not_started")
  assert.deepEqual(artifact.claimed_rules, [])
  assert.equal(artifact.public_read_only_preflight.length, 1)
  assert.equal(artifact.public_read_only_preflight[0].operation, "edit/PagePreviewModule")
  assert.equal(artifact.public_read_only_preflight[0].request_method, "POST")
  assert.equal(artifact.public_read_only_preflight[0].status, "ok")
  assert.match(artifact.public_read_only_preflight[0].body_sha256, /^[0-9a-f]{64}$/)
  assert.equal(artifact.public_read_only_preflight[0].edit_permission, false)
  assert.equal(artifact.public_read_only_preflight[0].mutation_contract_exposed, false)
  assert.ok(artifact.public_authority_missing.length >= 5)
  assert.deepEqual(artifact.public_authority_missing, artifact.remaining_gaps.filter((gap) => gap.kind === "missing_authority").map((gap) => gap.id))
  assert.equal(artifact.cleanup_receipt.mutation_was_started, false)
  assert.equal(artifact.cleanup_receipt.live_state_debt_created, false)
  assert.deepEqual(artifact.redactions, ["wikidot_token7 value omitted"])

  for (const [rule, controls] of Object.entries(fixture.control_matrix)) {
    assert.equal(controls.positive.length, 2, `${rule} must define exactly two positive controls`)
    assert.equal(controls.negative.length, 2, `${rule} must define exactly two negative controls`)
  }

  const serialized = JSON.stringify(artifact)
  for (const [label, pattern] of [
    ["session value", /WIKIDOT_SESSION_ID=/i],
    ["password field", /"password"\s*:/i],
    ["email address", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
    ["raw cookie header", /"cookie"\s*:/i],
    ["csrf value", /"csrf(?:_token)?"\s*:/i],
    ["authorization header", /"authorization"\s*:/i],
  ]) {
    assert.equal(pattern.test(serialized), false, `artifact contains forbidden ${label}`)
  }
})
