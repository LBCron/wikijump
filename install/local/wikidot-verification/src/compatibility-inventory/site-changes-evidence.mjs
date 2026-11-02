import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function uniqueSortedStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value !== ""))].sort()
}

function phase(status, references = []) {
  return { status, references: uniqueSortedStrings(references) }
}

export const SITE_CHANGES_EVIDENCE_ARTIFACT =
  "install/local/wikidot-verification/artifacts/open43-readonly-live-20260810.json"
const SITE_CHANGES_EVIDENCE_ID = "E_OPEN43_SITECHANGES_AMC_20260810"
const SITE_CHANGES_SURFACE_ID =
  "framerail-amc-module:changes/SiteChangesListModule:parameters=categoryId,options,page,pageId,perpage"
const SITE_CHANGES_EXTERNAL_ROOT =
  "/home/roku/wjlab/evidence/20260808-open87-execution/pr2-open43-readonly-live-20260809"
const SITE_CHANGES_ARTIFACT_SHA256 =
  "9c98424c2082c7989e2c09e9c9c4e8082be8d3c8e42910383b3e323095b9a410"
const SITE_CHANGES_EXTERNAL_SHA256SUMS =
  "225897681df10c1e8c307053056849990fc32ebe10e47f2ab9012685bda709ff"
const SITE_CHANGES_CASES = Object.freeze([
  ["q1035-sitechanges-page-one", "6428a591526492e12c846d0dc84219979facaa91e2dd1dd431d608bffb075b9b", "b90e04799dc2404328a3de4ef7a1a36ec32e8ea2286c076ff1256909072e2061"],
  ["q1035-sitechanges-page-two", "1a23ac1e1e2e90998fd422e72fa3591ea64ef4ab47a2483225efbc08ee49c558", "73d0f678a9389be8244eb0d17445b4435f0f757d33e20c1c0df0c73a5b82c6d4"],
  ["q1035-sitechanges-page-three", "dca8256cbae00597b16e89277bc9f1cdd450a19c82f88c4e41e774827378b2fc", "ce24924d820e1aa93c6c971ec39c7a82acc937eb0f77b744862f3da4fe6a0426"],
  ["q1035-sitechanges-page-out", "b3042ab04ed5bebbd8ef01592419d74c26fd5c12c426f5c2b5704e62f1837c1f", "5aa7e88fdae452b00e35a553ce4f1f14576df652558d9ec98ea945c07d789190"],
  ["q1035-sitechanges-source", "d398d377cf35b669e7601b27c9f030fec00e34f8d75ae5e8b5a3c4e37330c658", "ca3160a51410c23a078ee5b5fc0ce9585c74bcb4c4c69a9c4430a5c913fce060"],
  ["q1035-sitechanges-files", "0605d698fb67cabd48bcfa7e8af447e7dacf145e4ae949eeffa1cf5e23aa8657", "f147b761ef7899ae98d614d6d089f02de14c22d6adde56f27ed354411d2a2f6a"],
  ["q1035-sitechanges-empty-options", "c7f1b199ea74def438865052cba7e9955cac18c00ee85dd6e2a1b74c66eea0bc", "b90e04799dc2404328a3de4ef7a1a36ec32e8ea2286c076ff1256909072e2061"],
  ["q1035-sitechanges-missing-category", "e1eb1c324af7c73d719a3f1011cc250ec8eab03ce47bca875f064bb3ce922ef2", "f3deef67552b3e7218eba33bc354c3e1562df93ac39b21f99855035c96e5a35b"]
])
const SITE_CHANGES_ANONYMOUS_INDEX_SHA256 =
  "65b89a3fb1758a80dd20766be15d183e94e5afa9a5e0a4f3405630cd5682fa36"
const SITE_CHANGES_AUTHENTICATED_INDEX_SHA256 =
  "0ee1786699c88fe36908aa46d8347c38519e4270be638041b82e477a9426e435"
const SITE_CHANGES_FLICKR_INDEX_SHA256 =
  "8bb2b1f0c038d0ca8b5e59ac99e7e8b916c3b87c87972a430bece513561bb9ce"

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`SiteChanges evidence has invalid ${label}`)
  }
}

function requireExactStrings(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`SiteChanges evidence ${label} drifted`)
  }
}

const SITE_CHANGES_FORMS = Object.freeze({
  "q1035-sitechanges-page-one": { categoryId: "", moduleName: "changes/SiteChangesListModule", options: '{"all":true}', page: 1, pageId: 74503778, perpage: 20 },
  "q1035-sitechanges-page-two": { categoryId: "", moduleName: "changes/SiteChangesListModule", options: '{"all":true}', page: 2, pageId: 74503778, perpage: 20 },
  "q1035-sitechanges-page-three": { categoryId: "", moduleName: "changes/SiteChangesListModule", options: '{"all":true}', page: 3, pageId: 74503778, perpage: 20 },
  "q1035-sitechanges-page-out": { categoryId: "", moduleName: "changes/SiteChangesListModule", options: '{"all":true}', page: 999999, pageId: 74503778, perpage: 20 },
  "q1035-sitechanges-source": { categoryId: "", moduleName: "changes/SiteChangesListModule", options: '{"source":true}', page: 1, pageId: 74503778, perpage: 20 },
  "q1035-sitechanges-files": { categoryId: "", moduleName: "changes/SiteChangesListModule", options: '{"files":true}', page: 1, pageId: 74503778, perpage: 20 },
  "q1035-sitechanges-empty-options": { categoryId: "", moduleName: "changes/SiteChangesListModule", options: "{}", page: 1, pageId: 74503778, perpage: 20 },
  "q1035-sitechanges-missing-category": { categoryId: "999999999", moduleName: "changes/SiteChangesListModule", options: '{"all":true}', page: 1, pageId: 74503778, perpage: 20 }
})

async function verifySiteChangesExternalEvidence(artifact) {
  const externalRoot = artifact.external_evidence_root
  const sumsPath = path.join(externalRoot, "SHA256SUMS")
  try {
    const sumsBytes = await fs.readFile(sumsPath)
    if (sha256(sumsBytes) !== SITE_CHANGES_EXTERNAL_SHA256SUMS) {
      throw new Error("SiteChanges evidence external SHA256SUMS drifted")
    }
    const sums = new Map(
      sumsBytes
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s{2,}/u))
        .filter(([digest, name]) => digest && name)
        .map(([digest, name]) => [name, digest])
    )
    const index = JSON.parse(await fs.readFile(path.join(externalRoot, "anonymous-index.json"), "utf8"))
    for (const [caseId, rawSha, responseSha] of SITE_CHANGES_CASES) {
      const entry = index.entries?.find(({ case_id: id }) => id === caseId)
      const rawName = `raw/${caseId}.json`
      if (!entry || entry.path !== path.join(externalRoot, rawName) || entry.sha256 !== rawSha) {
        throw new Error(`SiteChanges evidence raw index drifted: ${caseId}`)
      }
      if (sums.get(rawName) !== rawSha || sha256(await fs.readFile(path.join(externalRoot, rawName))) !== entry.sha256) {
        throw new Error(`SiteChanges evidence raw provenance drifted: ${caseId}`)
      }
      const capture = JSON.parse(await fs.readFile(path.join(externalRoot, rawName), "utf8"))
      if (
        capture.schema !== "wikijump.open43.readonly_live_response.v1" ||
        capture.actor_class !== "anonymous" ||
        capture.authenticated !== false ||
        capture.mutated !== false ||
        capture.request?.method !== "POST" ||
        capture.request?.url !== "https://scp-wiki.wikidot.com/ajax-module-connector.php" ||
        JSON.stringify(capture.request.form) !== JSON.stringify(SITE_CHANGES_FORMS[caseId]) ||
        capture.response?.status !== 200 ||
        capture.response?.headers?.["content-type"] !== "text/plain; charset=UTF-8" ||
        capture.response?.body_sha256 !== responseSha
      ) {
        throw new Error(`SiteChanges evidence response contract drifted: ${caseId}`)
      }
      const envelope = JSON.parse(capture.response.body)
      if (envelope.status !== "ok" || typeof envelope.body !== "string") {
        throw new Error(`SiteChanges evidence success envelope drifted: ${caseId}`)
      }
    }
    return "verified"
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "unavailable"
    throw error
  }
}

export async function applySiteChangesEvidence(root, records, { readText }) {
  const artifactText = await readText(root, SITE_CHANGES_EVIDENCE_ARTIFACT)
  let artifact
  try {
    artifact = JSON.parse(artifactText)
  } catch (error) {
    throw new Error("invalid JSON in " + SITE_CHANGES_EVIDENCE_ARTIFACT + ": " + error.message)
  }
  if (sha256(artifactText) !== SITE_CHANGES_ARTIFACT_SHA256) {
    throw new Error("SiteChanges evidence artifact blob drifted")
  }
  if (
    artifact.schema !== "wikijump.open43.readonly_live_evidence.v1" ||
    artifact.captured_at !== "2026-08-10" ||
    artifact.mutated !== false ||
    !artifact.actor_classes?.includes("anonymous") ||
    artifact.privacy?.credentials_or_cookie_hits !== 0 ||
    JSON.stringify(artifact.privacy?.stored_response_headers_exclude) !==
      JSON.stringify(["authorization", "cookie", "set-cookie"]) ||
    artifact.external_evidence_root !== SITE_CHANGES_EXTERNAL_ROOT ||
    artifact.external_sha256s?.path !== `${SITE_CHANGES_EXTERNAL_ROOT}/SHA256SUMS` ||
    artifact.external_sha256s?.sha256 !== SITE_CHANGES_EXTERNAL_SHA256SUMS
  ) {
    throw new Error("SiteChanges evidence provenance drifted")
  }
  const expectedIndices = [
    ["anonymous-index.json", SITE_CHANGES_ANONYMOUS_INDEX_SHA256, 77],
    ["authenticated-index.json", SITE_CHANGES_AUTHENTICATED_INDEX_SHA256, 24],
    ["flickr-index.json", SITE_CHANGES_FLICKR_INDEX_SHA256, 12]
  ]
  if (
    !Array.isArray(artifact.external_indices) ||
    JSON.stringify(artifact.external_indices.map(({ path: indexPath, sha256: digest, cases }) => [path.basename(indexPath), digest, cases])) !==
      JSON.stringify(expectedIndices)
  ) {
    throw new Error("SiteChanges evidence index provenance drifted")
  }
  const rule = artifact.general_rules?.find(({ evidence_id: evidenceId }) => evidenceId === SITE_CHANGES_EVIDENCE_ID)
  if (!rule) throw new Error("SiteChanges evidence rule is missing")
  requireExactStrings(rule.case_ids, SITE_CHANGES_CASES.map(([caseId]) => caseId), "case IDs")
  if (
    rule.positive_controls !== 5 ||
    rule.negative_controls !== 2 ||
    rule.observation !== "changes/SiteChangesListModule accepts page, perpage, pageId, categoryId, and JSON options. Pages 1 through 3 render distinct ordered rows and pager state. source and files select their revision kinds. An out-of-range page and a nonexistent category return Sorry, no revisions matching your criteria."
  ) {
    throw new Error("SiteChanges evidence control summary drifted")
  }
  for (const [caseId, rawSha, responseSha] of SITE_CHANGES_CASES) {
    requireSha256(rawSha, `${caseId} raw hash`)
    requireSha256(responseSha, `${caseId} response hash`)
  }
  await verifySiteChangesExternalEvidence(artifact)
  return records.map((record) =>
    record.surface_id === SITE_CHANGES_SURFACE_ID
      ? { ...record, evidence: phase("available", [`${SITE_CHANGES_EVIDENCE_ARTIFACT}#${SITE_CHANGES_EVIDENCE_ID}`]) }
      : record
  )
}


