import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export const CANONICAL_IMPLEMENTATION_LEDGER = "scripts/data/wikidot-implementation-ledger.json"
export const DATA_FORM_SPECIFICATION_PREFIX = "docs/wikidot-specifications/specifications/data-forms/"
export const MODULE_SPECIFICATION_PREFIX = "docs/wikidot-specifications/specifications/module/"
export const LEDGER_STATUSES = new Set(["implemented", "in_progress", "pending", "blocked"])
export const DOCUMENTATION_STATUSES = new Set([
  "documented",
  "documented-deprecated",
  "documented-negative",
  "documented-plan-capability",
  "high-level-documentation",
  "invocation-only"
])

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

export function uniqueSortedStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value !== ""))].sort()
}

export function phase(status, references = []) {
  return { status, references: uniqueSortedStrings(references) }
}

export function surface({
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
  closure = phase("open"),
  implementationOwnerRecords = []
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
    implementation_owner_records: implementationOwnerRecords
  }
}

function assertExactKeys(value, expected, context) {
  const actual = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : []
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${context} has missing or extra keys`)
  }
}

function assertCanonicalStrings(values, context) {
  if (!Array.isArray(values) || JSON.stringify(values) !== JSON.stringify(uniqueSortedStrings(values))) {
    throw new Error(`${context} must be a sorted unique string array`)
  }
}

export function testReferences(tests) {
  if (!Array.isArray(tests)) return []
  return tests.flatMap((entry) => {
    if (typeof entry === "string") return [entry]
    if (!entry || typeof entry !== "object") return []
    if (typeof entry.path !== "string") return []
    return [typeof entry.name === "string" ? `${entry.path}#${entry.name}` : entry.path]
  })
}

export function repositoryDocumentationEvidence(entries) {
  if (!Array.isArray(entries)) return []
  return entries.flatMap((entry) => {
    if (typeof entry !== "string" || entry === "") return []
    if (path.posix.isAbsolute(entry)) {
      return []
    }
    if (
      entry.startsWith("docs/") ||
      entry.startsWith("install/") ||
      entry.startsWith("scripts/") ||
      entry.startsWith("deepwell/") ||
      entry.startsWith("framerail/") ||
      entry.startsWith("wws/")
    ) {
      return [entry]
    }
    return [path.posix.join("docs/wikidot-specifications", entry)]
  })
}

export async function validateCatalogOwnerRecords(root, featureId, ledgerEntry, ownerManifest, ledgerPath) {
  assertExactKeys(ownerManifest, ["issue_scope", "owners"], `${ledgerPath} ${featureId}`)
  assertExactKeys(ownerManifest.issue_scope, ["status", "references"], `${ledgerPath} ${featureId} issue_scope`)
  if (!(ownerManifest.issue_scope.status === "resolved" || ownerManifest.issue_scope.status === "unresolved")) {
    throw new Error(`${ledgerPath} ${featureId} has an unknown issue scope status`)
  }
  const issueReferences = ownerManifest.issue_scope.references
  if (
    !Array.isArray(issueReferences) ||
    JSON.stringify(issueReferences) !== JSON.stringify([...new Set(issueReferences)].sort((left, right) => left - right)) ||
    issueReferences.some((issue) => !Number.isSafeInteger(issue) || issue <= 0) ||
    (ownerManifest.issue_scope.status === "unresolved" && issueReferences.length !== 0) ||
    (ownerManifest.issue_scope.status === "resolved" && issueReferences.length === 0)
  ) {
    throw new Error(`${ledgerPath} ${featureId} has invalid issue scope references`)
  }
  if (!Array.isArray(ownerManifest.owners)) {
    throw new Error(`${ledgerPath} ${featureId} owners must be an array`)
  }
  const sourceReferences = new Set(ledgerEntry.implementation_files ?? [])
  const testReferenceSet = new Set(testReferences(ledgerEntry.tests))
  const owners = new Set()
  for (const ownerRecord of ownerManifest.owners) {
    assertExactKeys(ownerRecord, ["owner", "source_references", "test_references"], `${ledgerPath} ${featureId} owner`)
    if (typeof ownerRecord.owner !== "string" || ownerRecord.owner === "" || owners.has(ownerRecord.owner)) {
      throw new Error(`${ledgerPath} ${featureId} has a missing or duplicate owner`)
    }
    owners.add(ownerRecord.owner)
    assertCanonicalStrings(ownerRecord.source_references, `${ledgerPath} ${featureId} ${ownerRecord.owner} source_references`)
    assertCanonicalStrings(ownerRecord.test_references, `${ledgerPath} ${featureId} ${ownerRecord.owner} test_references`)
    if (ownerRecord.source_references.length === 0 || ownerRecord.test_references.length === 0) {
      throw new Error(`${ledgerPath} ${featureId} ${ownerRecord.owner} must cite source and test identities`)
    }
    for (const sourceReference of ownerRecord.source_references) {
      if (!sourceReferences.has(sourceReference)) {
        throw new Error(`${ledgerPath} ${featureId} ${ownerRecord.owner} cites an unlisted source: ${sourceReference}`)
      }
      try {
        await fs.access(path.join(root, sourceReference))
      } catch {
        throw new Error(`${ledgerPath} ${featureId} cites a missing source: ${sourceReference}`)
      }
    }
    for (const testReference of ownerRecord.test_references) {
      if (!testReferenceSet.has(testReference)) {
        throw new Error(`${ledgerPath} ${featureId} ${ownerRecord.owner} cites an unlisted test: ${testReference}`)
      }
      for (const testPath of testReference.split("; ")
        .map((reference) => reference.split(/#|::/u, 1)[0])
        .filter((reference, index) => index === 0 || reference.includes("/"))) {
        try {
          await fs.access(path.join(root, testPath))
        } catch {
          throw new Error(`${ledgerPath} ${featureId} cites a missing test: ${testPath}`)
        }
      }
    }
  }
  return ownerManifest
}

export async function discoverCatalogFeatures(root, { readJson, sourceInputs }) {
  const catalogPath = "docs/wikidot-specifications/catalog.json"
  const ledgerPath = "docs/wikidot-specifications/implementation-ledger.json"
  const observationsPath = "docs/wikidot-specifications/live-observations.json"
  const coveragePath = "docs/wikidot-specifications/source-coverage.json"
  const [catalog, mirrorLedger, canonicalLedger, liveObservations, sourceCoverage] = await Promise.all([
    readJson(root, catalogPath),
    readJson(root, ledgerPath),
    readJson(root, CANONICAL_IMPLEMENTATION_LEDGER),
    readJson(root, observationsPath),
    readJson(root, coveragePath)
  ])
  if (sourceInputs.get(ledgerPath) !== sourceInputs.get(CANONICAL_IMPLEMENTATION_LEDGER)) {
    throw new Error(`${CANONICAL_IMPLEMENTATION_LEDGER} and ${ledgerPath} must be byte-identical`)
  }
  const ledger = canonicalLedger
  if (ledger.catalog_sha256 !== sha256(sourceInputs.get(catalogPath))) {
    throw new Error(`${CANONICAL_IMPLEMENTATION_LEDGER} catalog_sha256 does not match ${catalogPath}`)
  }
  if (!Array.isArray(catalog.features)) throw new Error(`${catalogPath} features must be an array`)
  if (catalog.feature_count !== undefined && catalog.feature_count !== catalog.features.length) {
    throw new Error(`${catalogPath} feature_count does not match its feature denominator`)
  }
  if (!ledger.features || Array.isArray(ledger.features) || typeof ledger.features !== "object") {
    throw new Error(`${CANONICAL_IMPLEMENTATION_LEDGER} features must be an object`)
  }
  if (!Array.isArray(liveObservations.observations)) {
    throw new Error(`${observationsPath} observations must be an array`)
  }
  if (!Array.isArray(sourceCoverage.pages)) {
    throw new Error(`${coveragePath} pages must be an array`)
  }

  const ownerFeaturePrefixes = [
    DATA_FORM_SPECIFICATION_PREFIX,
    MODULE_SPECIFICATION_PREFIX,
    "docs/wikidot-specifications/specifications/site-structure/"
  ]
  const ownerFeatures = catalog.features.filter(({ specification }) =>
    ownerFeaturePrefixes.some((prefix) =>
      path.posix.join("docs/wikidot-specifications", specification).startsWith(prefix)
    )
  )
  const ownerManifests = ledger.implementation_owner_records ?? {}
  const ownerManifestIds = Object.keys(ownerManifests).sort()
  const ownerFeatureIds = ownerFeatures.map(({ id }) => id).sort()
  if (JSON.stringify(ownerManifestIds) !== JSON.stringify(ownerFeatureIds)) {
    throw new Error(`${CANONICAL_IMPLEMENTATION_LEDGER} implementation_owner_records must exactly cover owned catalog groups`)
  }

  const catalogIds = new Set()
  const records = []
  for (const feature of catalog.features) {
    if (!feature || typeof feature.id !== "string" || feature.id === "") {
      throw new Error(`${catalogPath} contains a feature without an id`)
    }
    if (catalogIds.has(feature.id)) throw new Error(`duplicate catalog feature: ${feature.id}`)
    catalogIds.add(feature.id)
    if (!DOCUMENTATION_STATUSES.has(feature.documentation_status)) {
      throw new Error(
        `unknown documentation status for ${feature.id}: ${feature.documentation_status}`
      )
    }
    if (typeof feature.specification !== "string" || feature.specification === "") {
      throw new Error(`missing public reference for catalog feature: ${feature.id}`)
    }
    const ledgerEntry = ledger.features[feature.id]
    if (!ledgerEntry) throw new Error(`catalog feature has no ledger entry: ${feature.id}`)
    if (!LEDGER_STATUSES.has(ledgerEntry.status)) {
      throw new Error(`unknown ledger status for ${feature.id}: ${ledgerEntry.status}`)
    }
    const specification = path.posix.join("docs/wikidot-specifications", feature.specification)
    const documentationEvidence = repositoryDocumentationEvidence(
      ledgerEntry.documentation_evidence
    )
    const liveOracleEvidence = repositoryDocumentationEvidence(
      ledgerEntry.live_oracle_evidence
    )
    const ownerManifest = ownerFeaturePrefixes.some((prefix) => specification.startsWith(prefix))
      ? await validateCatalogOwnerRecords(
        root,
        feature.id,
        ledgerEntry,
        ownerManifests[feature.id],
        CANONICAL_IMPLEMENTATION_LEDGER
      )
      : null
    records.push(
      surface({
        surfaceId: `catalog-feature:${feature.id}`,
        kind: "catalog_feature",
        publicOwner: "docs/wikidot-specifications",
        publicReference: [specification],
        issues: ownerManifest?.issue_scope.references ?? [],
        tests: testReferences(ledgerEntry.tests),
        evidence: phase("available", [specification, ...documentationEvidence, ...liveOracleEvidence]),
        source: phase(ledgerEntry.status, ledgerEntry.implementation_files ?? []),
        implementationOwnerRecords: ownerManifest?.owners ?? []
      })
    )
  }
  for (const ledgerId of Object.keys(ledger.features)) {
    if (!catalogIds.has(ledgerId)) throw new Error(`orphan ledger feature: ${ledgerId}`)
  }

  const coveragePages = new Map()
  for (const page of sourceCoverage.pages) {
    if (!page || typeof page.source_path !== "string" || page.source_path === "") {
      throw new Error(`${coveragePath} contains a page without source_path`)
    }
    if (coveragePages.has(page.source_path)) {
      throw new Error(`${coveragePath} contains duplicate page: ${page.source_path}`)
    }
    if (!/^[0-9a-f]{64}$/u.test(page.source_sha256 ?? "")) {
      throw new Error(`${coveragePath} has invalid source hash: ${page.source_path}`)
    }
    if (!Array.isArray(page.feature_ids)) {
      throw new Error(`${coveragePath} ${page.source_path} feature_ids must be an array`)
    }
    if (new Set(page.feature_ids).size !== page.feature_ids.length) {
      throw new Error(`${coveragePath} ${page.source_path} has duplicate feature edges`)
    }
    for (const featureId of page.feature_ids) {
      if (!catalogIds.has(featureId)) throw new Error(`${coveragePath} links unknown feature: ${featureId}`)
    }
    coveragePages.set(page.source_path, page)
  }
  if (sourceCoverage.listed_page_count !== sourceCoverage.pages.length) {
    throw new Error(`${coveragePath} listed_page_count does not match its page denominator`)
  }
  if (
    sourceCoverage.page_count !==
    sourceCoverage.listed_page_count + sourceCoverage.excluded_data_record_count
  ) {
    throw new Error(`${coveragePath} page_count does not match listed and excluded pages`)
  }
  const classifiedPageCount = Object.values(sourceCoverage.classification_counts ?? {}).reduce(
    (sum, count) => sum + count,
    0
  )
  if (classifiedPageCount !== sourceCoverage.page_count || sourceCoverage.unclassified_count !== 0) {
    throw new Error(`${coveragePath} classification denominator does not match`)
  }
  for (const feature of catalog.features) {
    const sourceEdges = new Set()
    for (const source of feature.sources ?? []) {
      const sourceEdge = JSON.stringify([
        source.path,
        source.start_line ?? null,
        source.end_line ?? null,
        source.role ?? null
      ])
      if (sourceEdges.has(sourceEdge)) {
        throw new Error(`catalog feature ${feature.id} has duplicate source edge: ${source.path}`)
      }
      sourceEdges.add(sourceEdge)
      const coveragePage = coveragePages.get(source.path)
      if (!coveragePage || coveragePage.source_sha256 !== source.source_sha256) {
        throw new Error(`catalog feature ${feature.id} source coverage drift: ${source.path}`)
      }
      if (!coveragePage.feature_ids.includes(feature.id)) {
        throw new Error(`catalog feature ${feature.id} source edge is missing from coverage: ${source.path}`)
      }
    }
  }

  const observationsById = new Map()
  for (const observation of liveObservations.observations) {
    if (!observation || typeof observation.id !== "string" || observation.id === "") {
      throw new Error(`${observationsPath} contains an observation without an id`)
    }
    if (observationsById.has(observation.id)) {
      throw new Error(`duplicate live observation: ${observation.id}`)
    }
    if (!Array.isArray(observation.feature_ids)) {
      throw new Error(`live observation ${observation.id} feature_ids must be an array`)
    }
    const featureIds = new Set()
    for (const featureId of observation.feature_ids) {
      if (featureIds.has(featureId)) {
        throw new Error(`live observation ${observation.id} has duplicate feature link: ${featureId}`)
      }
      featureIds.add(featureId)
      if (!catalogIds.has(featureId)) throw new Error(`unknown catalog feature: ${featureId}`)
    }
    observationsById.set(observation.id, featureIds)
  }

  for (const feature of catalog.features) {
    if (!Array.isArray(feature.live_observation_ids)) {
      throw new Error(`catalog feature ${feature.id} live_observation_ids must be an array`)
    }
    const observationIds = new Set()
    for (const observationId of feature.live_observation_ids) {
      if (observationIds.has(observationId)) {
        throw new Error(`catalog feature ${feature.id} has duplicate observation link: ${observationId}`)
      }
      observationIds.add(observationId)
      const featureIds = observationsById.get(observationId)
      if (!featureIds) throw new Error(`unknown live observation: ${observationId}`)
      if (!featureIds.has(feature.id)) {
        throw new Error(`catalog ${feature.id} links ${observationId} without a reverse link`)
      }
    }
  }
  for (const [observationId, featureIds] of observationsById) {
    for (const featureId of featureIds) {
      const feature = catalog.features.find(({ id }) => id === featureId)
      if (!feature.live_observation_ids.includes(observationId)) {
        throw new Error(`live observation ${observationId} links ${featureId} without a reverse link`)
      }
    }
  }
  return records
}
