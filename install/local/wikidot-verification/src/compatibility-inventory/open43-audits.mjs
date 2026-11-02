import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { CANDIDATE_CASE_SETS } from "../candidate-case-command.mjs"

const AUDIT_CLASSIFICATIONS = new Set([
  "source_ready",
  "needs_source",
  "candidate_required",
  "blocked_evidence"
])
const BLOCKED_ROUTE_CLASSES = new Set([
  "anonymous_read_only",
  "authenticated_read_only",
  "run_owned_mutation",
  "local_candidate",
  "live_browser_only",
  "missing_public_producer",
  "missing_architecture_domain_authority",
  "missing_security_policy"
])
const BLOCKED_ROUTE_STATUSES = new Set([
  "not_attempted_not_safe",
  "partial_evidence_acquired",
  "blocked_no_positive_fixture",
  "blocked_missing_domain_authority",
  "blocked_no_provider_success",
  "blocked_no_mapping"
])

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function uniqueSortedStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value !== ""))].sort()
}

function phase(status, references = []) {
  return { status, references: uniqueSortedStrings(references) }
}

function surface({
  surfaceId,
  kind,
  publicOwner,
  publicReference,
  issues = [],
  cases = [],
  tests = [],
  evidence = phase("missing"),
  source = phase("implemented"),
  candidate = phase("pending"),
  standing = phase("pending"),
  closure = phase("open")
}) {
  return {
    surface_id: surfaceId,
    kind,
    public_owner: publicOwner,
    public_reference: uniqueSortedStrings(publicReference),
    existing_refs: {
      issues: [...new Set(issues)].sort((left, right) => left - right),
      cases: uniqueSortedStrings(cases),
      tests: uniqueSortedStrings(tests)
    },
    evidence,
    source,
    candidate,
    standing,
    closure,
    implementation_owner_records: []
  }
}

function isCanonicalRepositoryReference(reference) {
  if (typeof reference !== "string" || reference === "" || reference.trim() !== reference) {
    return false
  }
  const fragmentIndex = reference.indexOf("#")
  const referencePath = fragmentIndex < 0 ? reference : reference.slice(0, fragmentIndex)
  const fragment = fragmentIndex < 0 ? null : reference.slice(fragmentIndex + 1)
  const normalizedPath = referencePath.split(path.sep).join("/")
  return (
    referencePath !== "" &&
    !path.isAbsolute(referencePath) &&
    path.normalize(referencePath).split(path.sep).join("/") === normalizedPath &&
    normalizedPath !== "." &&
    normalizedPath !== ".." &&
    !normalizedPath.startsWith("../") &&
    fragment !== ""
  )
}

function testReferences(tests) {
  if (!Array.isArray(tests)) return []
  return tests.flatMap((entry) => {
    if (typeof entry === "string") return [entry]
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string") return []
    return [typeof entry.name === "string" ? `${entry.path}#${entry.name}` : entry.path]
  })
}

function classificationCounts(rows) {
  return Object.fromEntries(
    [...AUDIT_CLASSIFICATIONS].map((classification) => [
      classification,
      rows.filter((row) => row.classification === classification).length
    ])
  )
}

function assertSameCounts(actual, expected, context) {
  for (const key of AUDIT_CLASSIFICATIONS) {
    if (expected?.[key] !== actual[key]) {
      throw new Error(`${context} ${key} count does not match: expected ${expected?.[key]}, got ${actual[key]}`)
    }
  }
}

function auditTests(row) {
  const evidenceTests = Array.isArray(row.evidence)
    ? row.evidence.flatMap((entry) => {
        if (typeof entry !== "string") return []
        if (!entry.startsWith("deepwell/tests/") &&
            !entry.startsWith("framerail/tests/") &&
            !entry.startsWith("install/local/wikidot-verification/tests/")) return []
        return [entry.replace("::", "#")]
      })
    : []
  return uniqueSortedStrings([
    ...testReferences(row.tests),
    ...testReferences(row.public_tests),
    ...testReferences(row.existing_tests),
    ...evidenceTests
  ])
}

function candidateCaseTests() {
  const references = new Map()
  for (const [name, registered] of Object.entries(CANDIDATE_CASE_SETS)) {
    if (registered.aliasOf !== undefined) continue
    const matches = [...registered.load.toString().matchAll(/import\("(\.\/[^"]+\.mjs)"\)/gu)]
    if (matches.length !== 1) {
      throw new Error(`candidate case set ${name} does not expose exactly one executable module import`)
    }
    const testPath = `install/local/wikidot-verification/src/${matches[0][1].slice(2)}`
    for (const caseId of registered.caseIds) {
      if (references.has(caseId)) {
        throw new Error(`candidate case ID ${caseId} is registered by multiple execution case sets`)
      }
      references.set(caseId, testPath)
    }
  }
  return references
}

async function authoritativeAuditTests(root, auditPath, issue, sourceRevision, pinnedSources) {
  const testsByCase = new Map()
  const descriptors = []
  if (issue.authoritative_manifest !== undefined) descriptors.push(issue.authoritative_manifest)
  if (issue.authoritative_manifests !== undefined) {
    if (!Array.isArray(issue.authoritative_manifests)) {
      throw new Error(`${auditPath} authoritative_manifests must be an array`)
    }
    descriptors.push(...issue.authoritative_manifests.filter(({ case_inventory: caseInventory }) => caseInventory === true))
  }
  for (const descriptor of descriptors) {
    if (
      !descriptor ||
      typeof descriptor !== "object" ||
      Array.isArray(descriptor) ||
      typeof descriptor.path !== "string" ||
      descriptor.path === "" ||
      !/^[0-9a-f]{64}$/u.test(descriptor.sha256 ?? "")
    ) {
      throw new Error(`${auditPath} contains an invalid authoritative manifest`)
    }
    const revision = descriptor.source_revision ?? sourceRevision
    if (!/^[0-9a-f]{40}$/u.test(revision ?? "")) {
      throw new Error(`${auditPath} ${descriptor.path} has invalid authoritative manifest source_revision`)
    }
    const spec = `${revision}:${descriptor.path}`
    const bytes = pinnedSources.get(spec)
    if (!bytes) {
      throw new Error(`${auditPath} cannot read authoritative manifest ${revision}:${descriptor.path}`)
    }
    if (sha256(bytes) !== descriptor.sha256) {
      throw new Error(`${auditPath} authoritative manifest digest does not match ${revision}:${descriptor.path}`)
    }
    let manifest
    try {
      manifest = JSON.parse(bytes.toString("utf8"))
    } catch (error) {
      throw new Error(`${auditPath} authoritative manifest ${descriptor.path} is invalid JSON: ${error.message}`)
    }
    if (!Array.isArray(manifest.cases)) {
      throw new Error(`${auditPath} authoritative manifest ${descriptor.path} cases must be an array`)
    }
    const manifestCaseIds = new Set()
    for (const entry of manifest.cases) {
      if (!entry || typeof entry.case_id !== "string" || entry.case_id === "") {
        throw new Error(`${auditPath} authoritative manifest ${descriptor.path} contains a case without case_id`)
      }
      if (manifestCaseIds.has(entry.case_id)) {
        throw new Error(`${auditPath} authoritative manifest ${descriptor.path} contains duplicate case ${entry.case_id}`)
      }
      manifestCaseIds.add(entry.case_id)
      const historicalReferences = uniqueSortedStrings([
        ...(typeof entry.test === "string" && entry.test !== "" ? [entry.test] : []),
        ...testReferences(entry.tests),
        ...(typeof entry.public_test === "string" && entry.public_test !== "" ? [entry.public_test] : []),
        ...testReferences(entry.public_tests)
      ])
      const currentReferences = []
      for (const reference of historicalReferences) {
        const [testPath, anchor = ""] = reference.split(/#|::/u, 2)
        if (!isCanonicalRepositoryReference(testPath)) {
          throw new Error(`${auditPath} ${entry.case_id} has invalid authoritative test reference: ${reference}`)
        }
        let source
        try {
          source = await fs.readFile(path.join(root, testPath), "utf8")
        } catch {
          continue
        }
        if (anchor !== "" && !source.includes(anchor)) continue
        currentReferences.push(reference)
      }
      testsByCase.set(
        entry.case_id,
        uniqueSortedStrings([...(testsByCase.get(entry.case_id) ?? []), ...currentReferences])
      )
    }
  }
  return testsByCase
}

function auditCompletion(classification, row) {
  if (!AUDIT_CLASSIFICATIONS.has(classification)) {
    throw new Error(`unknown Open43 audit classification: ${classification}`)
  }
  if (classification === "blocked_evidence") {
    return {
      evidence: phase("blocked"),
      source: phase("implemented"),
      candidate: phase("blocked"),
      standing: phase("blocked"),
      closure: phase("blocked")
    }
  }
  const candidateReferences = classification === "candidate_required"
    ? uniqueSortedStrings([
        `candidate-case:${row.case_id}`,
        ...(Array.isArray(row.next_command_ids) ? row.next_command_ids : [])
      ])
    : []
  return {
    evidence: phase("available"),
    source: phase(classification === "needs_source" ? "pending" : "implemented"),
    candidate: phase("pending", candidateReferences),
    standing: phase("pending"),
    closure: phase("open")
  }
}

function validateNestedAuditSources(root, auditPath, audit, sourceRevision, readGitSpecBatch) {
  if (!/^[0-9a-f]{40}$/u.test(sourceRevision ?? "")) {
    throw new Error(`${auditPath} has no source_revision`)
  }
  const references = []
  const visit = (value) => {
    if (!value || typeof value !== "object") return
    if (!Array.isArray(value) && typeof value.path === "string" && value.sha256 !== undefined) {
      if (!/^[0-9a-f]{64}$/u.test(value.sha256)) {
        throw new Error(`${auditPath} has an invalid nested source digest for ${value.path}`)
      }
      if (!path.isAbsolute(value.path) && !/^ftml@[0-9a-f]{40}:/u.test(value.path)) {
        if (!isCanonicalRepositoryReference(value.path) || value.path.includes("#")) {
          throw new Error(`${auditPath} has an invalid nested source path: ${value.path}`)
        }
        const revision = value.source_revision ?? sourceRevision
        if (!/^[0-9a-f]{40}$/u.test(revision)) {
          throw new Error(`${auditPath} ${value.path} has invalid source_revision`)
        }
        if (value.source_revision === sourceRevision) {
          throw new Error(`${auditPath} ${value.path} has a redundant source_revision`)
        }
        references.push({
          spec: `${revision}:${value.path}`,
          revision,
          path: value.path,
          sha256: value.sha256
        })
      }
    }
    for (const nested of Object.values(value)) visit(nested)
  }
  visit(audit)
  let pinnedSources
  try {
    pinnedSources = readGitSpecBatch(
      ["-C", root],
      references.map(({ spec }) => spec),
      `${auditPath} nested sources`
    )
  } catch (error) {
    throw new Error(`${auditPath} cannot read nested source: ${error.message}`)
  }
  for (const reference of references) {
    const source = pinnedSources.get(reference.spec)
    if (!source) {
      throw new Error(`${auditPath} cannot read nested source ${reference.revision}:${reference.path}`)
    }
    if (sha256(source) !== reference.sha256) {
      throw new Error(`${auditPath} nested source digest does not match ${reference.revision}:${reference.path}`)
    }
  }
  return pinnedSources
}

export async function discoverOpen43AuditCases(root, { readJson, readText, readGitSpecBatch }) {
  const routingPath = "docs/development/open43-blocked-evidence-routing.json"
  const reconciliationPath =
    "docs/development/open43-closure-audit-ownership-reconciliation.json"
  const routing = await readJson(root, routingPath)
  const reconciliation = await readJson(root, reconciliationPath)
  if (routing.schema !== "wikijump.open43.blocked_evidence_routing.v1") {
    throw new Error(`${routingPath} has an unsupported schema`)
  }
  if (reconciliation.schema !== "wikijump.open43.closure_audit_ownership_reconciliation.v1") {
    throw new Error(`${reconciliationPath} has an unsupported schema`)
  }
  if (!Array.isArray(routing.source_audits) || routing.source_audits.length !== 7) {
    throw new Error(`${routingPath} must declare exactly seven source audits`)
  }
  if (new Set(routing.source_audits).size !== routing.source_audits.length) {
    throw new Error(`${routingPath} contains a duplicate source audit`)
  }

  if (
    !routing.route_classes ||
    Array.isArray(routing.route_classes) ||
    new Set(Object.keys(routing.route_classes)).size !== BLOCKED_ROUTE_CLASSES.size ||
    [...BLOCKED_ROUTE_CLASSES].some((routeClass) =>
      typeof routing.route_classes[routeClass] !== "string" ||
      routing.route_classes[routeClass] === ""
    )
  ) {
    throw new Error(`${routingPath} route_classes do not match the closed vocabulary`)
  }
  if (!Array.isArray(routing.rows)) throw new Error(`${routingPath} rows must be an array`)
  if (!Array.isArray(reconciliation.closure_audits)) {
    throw new Error(`${reconciliationPath} closure_audits must be an array`)
  }
  const reconciliationAudits = new Map(
    reconciliation.closure_audits.map((entry) => [entry.path, entry])
  )
  if (
    reconciliationAudits.size !== routing.source_audits.length ||
    routing.source_audits.some((auditPath) => !reconciliationAudits.has(auditPath))
  ) {
    throw new Error(`${reconciliationPath} does not own the same seven source audits`)
  }

  const records = []
  const registeredCandidateTests = candidateCaseTests()
  const auditRows = []
  for (const auditPath of routing.source_audits) {
    if (typeof auditPath !== "string" || !auditPath.startsWith("docs/development/")) {
      throw new Error(`${routingPath} contains an invalid source audit path`)
    }
    const auditText = await readText(root, auditPath)
    let audit
    try {
      audit = JSON.parse(auditText)
    } catch (error) {
      throw new Error(`invalid JSON in ${auditPath}: ${error.message}`)
    }
    if (!Array.isArray(audit.issues)) throw new Error(`${auditPath} issues must be an array`)
    const reconciliationAudit = reconciliationAudits.get(auditPath)
    if (reconciliationAudit.sha256 !== sha256(auditText)) {
      throw new Error(`${auditPath} reconciliation digest does not match`)
    }
    const pinnedAuditSources = validateNestedAuditSources(
      root,
      auditPath,
      audit,
      reconciliationAudit.source_revision,
      readGitSpecBatch
    )
    const currentAuditRows = []
    const fallbackOwner = typeof audit.schema === "string" ? audit.schema : "open43-audit"
    for (const issue of audit.issues) {
      const issueNumber = issue.issue ?? issue.number
      if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
        throw new Error(`${auditPath} contains an audit case without an issue owner`)
      }
      const authoritativeTests = await authoritativeAuditTests(
        root,
        auditPath,
        issue,
        reconciliationAudit.source_revision,
        pinnedAuditSources
      )
      const classifiedRows = []
      if (Array.isArray(issue.subrows)) {
        for (const row of issue.subrows) {
          classifiedRows.push({ row, classification: row.classification ?? row.status })
        }
      } else {
        for (const classification of AUDIT_CLASSIFICATIONS) {
          const rows = issue[classification] ?? []
          if (!Array.isArray(rows)) {
            throw new Error(`${auditPath} issue ${issueNumber} ${classification} must be an array`)
          }
          for (const row of rows) classifiedRows.push({ row, classification })
        }
      }
      for (const { row, classification } of classifiedRows) {
        if (!row || typeof row.case_id !== "string" || row.case_id === "") {
          throw new Error(`${auditPath} issue ${issueNumber} contains a case without case_id`)
        }
        const auditRow = { caseId: row.case_id, classification, issueNumber }
        currentAuditRows.push(auditRow)
        auditRows.push(auditRow)
        records.push(
          surface({
            surfaceId: `open43-audit-case:${row.case_id}`,
            kind: "open43_audit_case",
            publicOwner:
              typeof row.owner === "string" && row.owner !== "" ? row.owner : fallbackOwner,
            publicReference: [`${auditPath}#${row.case_id}`],
            issues: [issueNumber],
            cases: [row.case_id],
            tests: uniqueSortedStrings([
              ...auditTests(row),
              ...(authoritativeTests.get(row.case_id) ?? []),
              ...(classification === "candidate_required" && registeredCandidateTests.has(row.case_id)
                ? [registeredCandidateTests.get(row.case_id)]
                : [])
            ]),
            ...auditCompletion(classification, row)
          })
        )
      }
    }
    if (reconciliationAudit.issue_count !== audit.issues.length) {
      throw new Error(`${auditPath} reconciliation issue_count does not match`)
    }
    if (reconciliationAudit.case_count !== currentAuditRows.length) {
      throw new Error(`${auditPath} reconciliation case_count does not match`)
    }
    assertSameCounts(
      classificationCounts(currentAuditRows),
      reconciliationAudit.classification_counts,
      `${auditPath} reconciliation`
    )
    if (Array.isArray(reconciliationAudit.issue_summaries)) {
      if (reconciliationAudit.issue_summaries.length !== audit.issues.length) {
        throw new Error(`${auditPath} reconciliation issue_summaries do not match`)
      }
      for (const summary of reconciliationAudit.issue_summaries) {
        const issueRows = currentAuditRows.filter((row) => row.issueNumber === summary.issue)
        if (summary.case_count !== issueRows.length) {
          throw new Error(`${auditPath} issue ${summary.issue} reconciliation case_count does not match`)
        }
        assertSameCounts(
          classificationCounts(issueRows),
          summary.classification_counts,
          `${auditPath} issue ${summary.issue} reconciliation`
        )
      }
    }
  }

  const caseIds = auditRows.map(({ caseId }) => caseId)
  const uniqueCaseIds = new Set(caseIds)
  const duplicateCaseIds = uniqueSortedStrings(
    caseIds.filter((caseId, index) => caseIds.indexOf(caseId) !== index)
  )
  if (
    reconciliation.after?.case_count !== auditRows.length ||
    reconciliation.after?.unique_case_count !== uniqueCaseIds.size ||
    JSON.stringify(uniqueSortedStrings(reconciliation.after?.duplicate_case_ids ?? [])) !==
      JSON.stringify(duplicateCaseIds)
  ) {
    throw new Error(`${reconciliationPath} aggregate case denominator does not match`)
  }
  assertSameCounts(
    classificationCounts(auditRows),
    reconciliation.after?.classification_counts,
    `${reconciliationPath} aggregate`
  )
  if ((reconciliation.after?.unknown_classifications ?? []).length !== 0) {
    throw new Error(`${reconciliationPath} records unknown classifications`)
  }

  const blockedCaseIds = uniqueSortedStrings(
    auditRows
      .filter(({ classification }) => classification === "blocked_evidence")
      .map(({ caseId }) => caseId)
  )
  const routedCaseIds = []
  const routedCounts = Object.fromEntries([...BLOCKED_ROUTE_CLASSES].map((name) => [name, 0]))
  for (const row of routing.rows) {
    if (!row || typeof row.case_id !== "string" || row.case_id === "") {
      throw new Error(`${routingPath} contains a row without case_id`)
    }
    if (!BLOCKED_ROUTE_CLASSES.has(row.route_class)) {
      throw new Error(`${routingPath} has unknown route_class for ${row.case_id}`)
    }
    if (!BLOCKED_ROUTE_STATUSES.has(row.status)) {
      throw new Error(`${routingPath} has unknown status for ${row.case_id}`)
    }
    if (typeof row.reason !== "string" || row.reason === "") {
      throw new Error(`${routingPath} has no reason for ${row.case_id}`)
    }
    routedCaseIds.push(row.case_id)
    routedCounts[row.route_class] += 1
  }
  if (
    new Set(routedCaseIds).size !== routedCaseIds.length ||
    JSON.stringify(uniqueSortedStrings(routedCaseIds)) !== JSON.stringify(blockedCaseIds)
  ) {
    throw new Error(`${routingPath} routing rows do not exactly match blocked_evidence cases`)
  }
  for (const routeClass of BLOCKED_ROUTE_CLASSES) {
    if (routing.counts?.[routeClass] !== routedCounts[routeClass]) {
      throw new Error(`${routingPath} ${routeClass} count does not match`)
    }
  }
  if (routing.counts?.total !== routedCaseIds.length) {
    throw new Error(`${routingPath} total count does not match`)
  }
  if (
    routing.integration_base !== undefined &&
    reconciliation.source?.integration_base !== undefined &&
    routing.integration_base !== reconciliation.source.integration_base
  ) {
    throw new Error(`${routingPath} and ${reconciliationPath} integration_base do not match`)
  }
  return { records, auditPaths: [...routing.source_audits] }
}

