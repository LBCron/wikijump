#!/usr/bin/env node
// Record a per-head attestation of targeted validation evidence in the
// validation store, for promote.py --validation-mode attestation.
//
// An attestation binds a head commit and its tree to the targeted checks
// that ran for it: either a pr-checks.yml GitHub Actions run (its
// successful area steps become entries) or explicit local entries (the
// only possible source for local-only groups such as theme_lab).
//
// Landing is write-once: an identical attestation already in the store
// is reported, and different content for the same head is an error, so
// evidence for a head can never be silently replaced.

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const ATTESTATION_SCHEMA = "wikijump.promotion_attestation.v1"
const SHA = /^[0-9a-f]{40}$/

// pr-checks.yml step name -> promote.py validation group. Steps with no
// group (the standing tooling tests cover the promotion tooling itself,
// not a validation group) are not attestation areas.
export const STEP_AREAS = new Map([
  ["Deepwell targeted tests and Clippy", "deepwell"],
  ["WWS targeted tests and formatting", "wws"],
  ["Framerail unit tests", "framerail"],
  ["Wikidot verification suite", "verification"],
  ["Workflow policy tests", "workflow"],
  ["Locales formatting", "locales"],
])

export function validationStore() {
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(stateHome, "wikijump", "validation")
}

export function attestationFileName(head) {
  if (typeof head !== "string" || !SHA.test(head)) {
    throw new Error(`not a full commit sha: ${head}`)
  }
  return `attestation-${head}.json`
}

export function buildAttestation({ head, tree, checks }) {
  if (!SHA.test(head ?? "")) throw new Error(`not a full commit sha: ${head}`)
  if (!SHA.test(tree ?? "")) throw new Error(`not a full tree sha: ${tree}`)
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new Error("an attestation needs at least one check entry")
  }
  for (const check of checks) {
    if (!check.area || !check.kind || !check.reference || !check.conclusion) {
      throw new Error(`check entries need area, kind, reference, conclusion: ${JSON.stringify(check)}`)
    }
  }
  return {
    schema: ATTESTATION_SCHEMA,
    wikijump_commit: head,
    wikijump_tree: tree,
    checks,
    recorded_at: new Date().toISOString(),
  }
}

export function checksFromPrChecksRun(run, jobs) {
  const checks = []
  const seen = new Set()
  for (const job of jobs ?? []) {
    for (const step of job.steps ?? []) {
      const area = STEP_AREAS.get(step.name)
      if (!area || seen.has(area)) continue
      if (step.conclusion !== "success") continue
      seen.add(area)
      checks.push({
        area,
        kind: "github-actions",
        reference: run.url,
        conclusion: "success",
      })
    }
  }
  return checks
}

export function landAttestation(storeDir, attestation) {
  const target = path.join(storeDir, attestationFileName(attestation.wikijump_commit))
  const text = `${JSON.stringify(attestation, null, 2)}\n`
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 })
  const temp = `${target}.tmp-${process.pid}`
  fs.writeFileSync(temp, text)
  try {
    fs.linkSync(temp, target)
    return { path: target, landed: true }
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    const existing = fs.readFileSync(target, "utf8")
    const stripRecordedAt = (value) => {
      const parsed = JSON.parse(value)
      delete parsed.recorded_at
      return JSON.stringify(parsed)
    }
    if (stripRecordedAt(existing) === stripRecordedAt(text)) {
      return { path: target, landed: false }
    }
    throw new Error(`a different attestation for ${attestation.wikijump_commit} is already recorded at ${target}`)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

function ghJson(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }))
}

function parseCheckArgument(raw) {
  const fields = {}
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=")
    if (eq < 1) throw new Error(`--check entries are key=value pairs: ${raw}`)
    fields[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return fields
}

export function recordValidationAttestation({ head, repository, storeDir, fromRun = null, extraChecks = [], run = ghJson }) {
  const tree = execFileSync("git", ["-C", repository, "rev-parse", `${head}^{tree}`], {
    encoding: "utf8",
  }).trim()
  const checks = [...extraChecks]
  if (fromRun) {
    const runInfo = run(["run", "view", String(fromRun), "--json", "headSha,conclusion,url"])
    if (runInfo.headSha !== head) {
      throw new Error(`run ${fromRun} is for head ${runInfo.headSha}, not ${head}`)
    }
    if (runInfo.conclusion !== "success") {
      throw new Error(`run ${fromRun} concluded ${runInfo.conclusion}, not success`)
    }
    const { jobs } = run(["api", `repos/Rokurolize/wikijump/actions/runs/${fromRun}/jobs`])
    checks.push(...checksFromPrChecksRun(runInfo, jobs))
  }
  const attestation = buildAttestation({ head, tree, checks })
  return { attestation, ...landAttestation(storeDir, attestation) }
}

function main(argv) {
  const options = { extraChecks: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === "--head") options.head = value
    else if (flag === "--repository") options.repository = value
    else if (flag === "--store") options.storeDir = value
    else if (flag === "--from-run") options.fromRun = value
    else if (flag === "--check") options.extraChecks.push(parseCheckArgument(value))
    else throw new Error(`unknown argument: ${flag}`)
    i += 1
  }
  if (!options.head) throw new Error("--head <full sha> is required")
  const repository =
    options.repository ?? fileURLToPath(new URL("../../../..", import.meta.url))
  const storeDir = options.storeDir ?? validationStore()
  const result = recordValidationAttestation({ ...options, repository, storeDir })
  process.stdout.write(
    `${JSON.stringify({ path: result.path, landed: result.landed, checks: result.attestation.checks }, null, 2)}\n`,
  )
}

const invokedAsScript =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (invokedAsScript) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`record-validation-attestation: ${error.message}\n`)
    process.exitCode = 1
  }
}
