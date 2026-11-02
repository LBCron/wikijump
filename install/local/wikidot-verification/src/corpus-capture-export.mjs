
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {codePointCompare, sha256Hex, stableStringify} from "./canonical-json.mjs";

export const CORPUS_CAPTURE_EXPORT_PROFILE = "wikijump-import-capture";
export const CORPUS_CAPTURE_EXPORT_TRANSPORTS = Object.freeze([
  "xmlrpc",
  "wikidot.py-fallback",
  "stored-capture",
]);

const CAPABILITY_QUERY_KEYS = new Set([
  "access_token",
  "auth",
  "authorization",
  "key",
  "session",
  "token",
  "ukey",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalizeCaptureValue(value, keyPath = "payload", redactions = []) {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      canonicalizeCaptureValue(item, `${keyPath}[${index}]`, redactions),
    );
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const [key, rawValue] of Object.entries(value)) {
      const childPath = keyPath === "" ? key : `${keyPath}.${key}`;
      if ((key === "download_url" || key === "url") && typeof rawValue === "string") {
        const {redacted, reason} = redactCapabilityUrl(rawValue);
        if (reason !== null) redactions.push({path: childPath, reason});
        result[key] = redacted;
      } else {
        result[key] = canonicalizeCaptureValue(rawValue, childPath, redactions);
      }
    }
    return result;
  }
  return value;
}

function redactCapabilityUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {redacted: url, reason: null};
  }
  const kept = [];
  let removed = false;
  for (const [key, value] of parsed.searchParams.entries()) {
    if (CAPABILITY_QUERY_KEYS.has(key.toLowerCase())) {
      removed = true;
    } else {
      kept.push([key, value]);
    }
  }
  if (!removed && parsed.hash === "") return {redacted: url, reason: null};
  parsed.search = "";
  for (const [key, value] of kept) parsed.searchParams.append(key, value);
  parsed.hash = "";
  return {redacted: parsed.toString(), reason: "capability_token_redacted"};
}

export function canonicalCorpusJsonBytes(value) {
  return Buffer.from(`${stableStringify(value)}\n`, "utf8");
}

// Python json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True).
function stableStringifyPretty(value, level = 0) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const pad = "  ".repeat(level + 1);
  const closePad = "  ".repeat(level);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => `${pad}${stableStringifyPretty(item, level + 1)}`);
    return `[\n${items.join(",\n")}\n${closePad}]`;
  }
  const keys = Object.keys(value).sort(codePointCompare);
  if (keys.length === 0) return "{}";
  const items = keys.map(
    (key) => `${pad}${JSON.stringify(key)}: ${stableStringifyPretty(value[key], level + 1)}`,
  );
  return `{\n${items.join(",\n")}\n${closePad}}`;
}

export function prettyCorpusJsonBytes(value) {
  return Buffer.from(`${stableStringifyPretty(value)}\n`, "utf8");
}

// Python json.dumps(value, ensure_ascii=False, sort_keys=True) with the
// default separators (", ", ": ") — the observations.ndjson line form.
function spacedStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => spacedStringify(item)).join(", ")}]`;
  const keys = Object.keys(value).sort(codePointCompare);
  return `{${keys
    .map((key) => `${JSON.stringify(key)}: ${spacedStringify(value[key])}`)
    .join(", ")}}`;
}

export function observationLineBytes(record) {
  return Buffer.from(`${spacedStringify(record)}\n`, "utf8");
}

function atomicWriteBytes(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, filePath);
}

function writeImmutableBytes(filePath, bytes, label) {
  if (fs.existsSync(filePath)) {
    if (!fs.readFileSync(filePath).equals(bytes)) {
      throw new Error(`${label}: immutable file exists with different bytes: ${filePath}`);
    }
    return false;
  }
  atomicWriteBytes(filePath, bytes);
  return true;
}

export function assertSafePageFullname(fullname) {
  if (
    typeof fullname !== "string" ||
    fullname.length === 0 ||
    fullname === "." ||
    fullname === ".." ||
    fullname.includes("/") ||
    fullname.includes("\\") ||
    fullname.includes("\0")
  ) {
    throw new Error(`page fullname is unsafe: ${String(fullname)}`);
  }
}

function assertSafeBranch(branch) {
  if (
    typeof branch !== "string" ||
    branch.length === 0 ||
    branch === "." ||
    branch === ".." ||
    branch.includes("/") ||
    branch.includes("\\") ||
    branch.includes("\0")
  ) {
    throw new Error("corpus branch must be one safe path component");
  }
}

export function rawCapturePayloadProblem(payload) {
  if (!isPlainObject(payload)) return "payload is not a JSON object";
  try {
    assertSafePageFullname(payload.fullname);
  } catch {
    return "payload fullname is missing or unsafe";
  }
  if (typeof payload.content !== "string") {
    return "payload has no string content field (not a raw capture)";
  }
  if (typeof payload.html !== "string") {
    return "payload has no string html field (not a raw capture)";
  }
  if (typeof payload.title !== "string") return "payload title is not a string";
  if (typeof payload.created_at !== "string" || payload.created_at.length === 0) {
    return "payload created_at is not a non-empty string";
  }
  if (typeof payload.updated_at !== "string" || payload.updated_at.length === 0) {
    return "payload updated_at is not a non-empty string";
  }
  return null;
}

export function deriveMetaProjection(canonicalPayload) {
  const meta = {};
  for (const [key, value] of Object.entries(canonicalPayload)) {
    if (key !== "content" && key !== "html") meta[key] = value;
  }
  if (!Object.hasOwn(meta, "parent_title")) meta.parent_title = null;
  if (!Object.hasOwn(meta, "title_shown")) meta.title_shown = null;
  return meta;
}

function emptyIndex() {
  return {schema_version: 1, entities: {}, by_site_created_at: {}, pending_ambiguities: []};
}

function loadIndex(branchRoot) {
  const indexPath = path.join(branchRoot, "index.json");
  if (!fs.existsSync(indexPath)) return emptyIndex();
  const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  if (!isPlainObject(parsed) || !isPlainObject(parsed.entities)) {
    throw new Error(`${indexPath}: corpus index has no entities object`);
  }
  return {
    schema_version: 1,
    entities: parsed.entities,
    by_site_created_at: isPlainObject(parsed.by_site_created_at)
      ? parsed.by_site_created_at
      : {},
    pending_ambiguities: Array.isArray(parsed.pending_ambiguities)
      ? parsed.pending_ambiguities
      : [],
  };
}

function readEntityIdFile(branchRoot, fullname) {
  const entityPath = path.join(branchRoot, "pages", fullname, "entity_id.txt");
  if (!fs.existsSync(entityPath)) return null;
  const text = fs.readFileSync(entityPath, "utf8").trim();
  return text.length > 0 ? text : null;
}

function resolveEntityId({branchRoot, identityBranchRoot, site, fullname}) {
  for (const root of [branchRoot, identityBranchRoot]) {
    if (root === null || root === undefined) continue;
    const fromFile = readEntityIdFile(root, fullname);
    if (fromFile !== null) return fromFile;
  }
  for (const root of [branchRoot, identityBranchRoot]) {
    if (root === null || root === undefined) continue;
    const indexPath = path.join(root, "index.json");
    if (!fs.existsSync(indexPath)) continue;
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    for (const entity of Object.values(parsed.entities ?? {})) {
      if (entity?.site === site && entity?.current_fullname === fullname) {
        return entity.entity_id;
      }
    }
  }
  return null;
}

function pushUnique(list, value) {
  if (typeof value === "string" && value.length > 0 && !list.includes(value)) {
    list.push(value);
  }
}

// Mirrors the Entity record written by identity.py: exactly the dataclass
// fields, because IdentityIndex.from_json_dict constructs Entity(**record).
function upsertIndexEntity(index, {entityId, site, meta, contentSha256, observedAt, runId}) {
  const existing = index.entities[entityId];
  const entity = existing ?? {
    entity_id: entityId,
    site,
    entity_type: "page",
    created_at: meta.created_at,
    first_seen_at: observedAt,
    aliases: {fullnames: [], titles: [], created_by_values: []},
    flags: [],
  };
  entity.aliases ??= {fullnames: [], titles: [], created_by_values: []};
  entity.aliases.fullnames ??= [];
  entity.aliases.titles ??= [];
  entity.aliases.created_by_values ??= [];
  pushUnique(entity.aliases.fullnames, meta.fullname);
  pushUnique(entity.aliases.titles, meta.title);
  pushUnique(entity.aliases.created_by_values, meta.created_by);
  entity.current_fullname = meta.fullname;
  entity.current_title = meta.title;
  entity.status = "active";
  entity.last_observed_at = observedAt;
  entity.last_checked_run_id = runId;
  entity.last_status_confirmed_at = observedAt;
  entity.latest_content_sha256 = contentSha256;
  entity.latest_updated_at = meta.updated_at;
  entity.latest_page_revision = Number.isInteger(meta.revisions) ? meta.revisions : null;
  entity.latest_tags = Array.isArray(meta.tags) ? [...meta.tags] : [];
  index.entities[entityId] = entity;
  const key = `${site}|${meta.created_at}`;
  const bucket = (index.by_site_created_at[key] ??= []);
  if (!bucket.includes(entityId)) bucket.push(entityId);
  return entity;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function classifyChange(branchRoot, fullname, meta, contentSha256) {
  const pageDir = path.join(branchRoot, "pages", fullname);
  const previousMeta = readJsonIfExists(path.join(pageDir, "meta.json"));
  const previousSourcePath = path.join(pageDir, "source.wikidot.txt");
  if (previousMeta === null || !fs.existsSync(previousSourcePath)) return ["first_seen"];
  const previousContentSha256 = `sha256:${sha256Hex(fs.readFileSync(previousSourcePath))}`;
  if (previousContentSha256 !== contentSha256) return ["content"];
  const metadataChanged =
    previousMeta.title !== meta.title ||
    previousMeta.updated_at !== meta.updated_at ||
    previousMeta.rating !== meta.rating ||
    previousMeta.revisions !== meta.revisions ||
    JSON.stringify(previousMeta.tags ?? []) !== JSON.stringify(meta.tags ?? []);
  return metadataChanged ? ["metadata"] : [];
}

class ExportRun {
  constructor({exportRoot, branch, site, runId, profile, startedAt}) {
    this.branchRoot = path.join(exportRoot, branch);
    this.site = site;
    this.branch = branch;
    this.runId = runId;
    this.profile = profile;
    this.startedAt = startedAt;
    this.responseCount = 0;
    this.runDir = path.join(this.branchRoot, "_runs", runId);
    this.responsesPath = path.join(this.runDir, "responses.ndjson");
    this.manifestPath = path.join(this.runDir, "manifest.json");
    fs.mkdirSync(path.join(this.branchRoot, "_objects", "sha256"), {recursive: true});
    fs.mkdirSync(this.runDir, {recursive: true});
    fs.mkdirSync(path.join(this.branchRoot, "pages"), {recursive: true});
    fs.mkdirSync(path.join(this.branchRoot, "by-uuid"), {recursive: true});
    if (!fs.existsSync(this.responsesPath)) fs.writeFileSync(this.responsesPath, "");
    this.writeManifest({status: "running"});
  }

  manifest(extra = {}) {
    return {
      schema_version: 1,
      run_id: this.runId,
      site: this.site,
      branch: this.branch,
      branch_root: this.branchRoot,
      profile: this.profile,
      transport: "xmlrpc",
      status: "running",
      started_at: this.startedAt,
      response_count: this.responseCount,
      failures: [],
      counts: {},
      complete_gate: {},
      ...extra,
    };
  }

  writeManifest(extra) {
    atomicWriteBytes(this.manifestPath, canonicalCorpusJsonBytes(this.manifest(extra)));
  }

  recordResponse({method, request, payload, receivedAt}) {
    const redactions = [];
    const canonicalPayload = canonicalizeCaptureValue(payload, "payload", redactions);
    const bytes = canonicalCorpusJsonBytes(canonicalPayload);
    const digest = sha256Hex(bytes);
    const objectPath = `_objects/sha256/${digest.slice(0, 2)}/${digest}.json`;
    writeImmutableBytes(path.join(this.branchRoot, objectPath), bytes, method);
    const reference = {
      method,
      object_path: objectPath,
      payload_sha256: `sha256:${digest}`,
      redactions,
    };
    const envelope = {
      schema_version: 1,
      run_id: this.runId,
      method,
      request: canonicalizeCaptureValue(request, "request", []),
      received_at: receivedAt,
      payload_object: objectPath,
      payload_sha256: reference.payload_sha256,
      redactions,
    };
    fs.appendFileSync(this.responsesPath, canonicalCorpusJsonBytes(envelope));
    this.responseCount += 1;
    return reference;
  }
}

export function exportCorpusCaptures({
  exportRoot,
  branch,
  site,
  runId,
  captures,
  identityCorpusRoot = null,
  profile = CORPUS_CAPTURE_EXPORT_PROFILE,
  startedAt = new Date().toISOString(),
  finishedAt = null,
}) {
  assertSafeBranch(branch);
  if (typeof site !== "string" || site.length === 0) {
    throw new Error("site must be a non-empty string");
  }
  if (typeof runId !== "string" || runId.length === 0 || runId.includes("/") || runId.includes("\\")) {
    throw new Error("run id must be one safe path component");
  }
  if (!Array.isArray(captures) || captures.length === 0) {
    throw new Error("at least one capture is required");
  }

  const exportable = [];
  const notExportable = [];
  for (const capture of captures) {
    const problem = rawCapturePayloadProblem(capture?.payload);
    if (problem !== null) {
      notExportable.push({
        fullname: typeof capture?.payload?.fullname === "string" ? capture.payload.fullname : null,
        reason: problem,
      });
      continue;
    }
    if (capture.meta_payload !== undefined && capture.meta_payload !== null) {
      if (!isPlainObject(capture.meta_payload)) {
        notExportable.push({fullname: capture.payload.fullname, reason: "meta_payload is not a JSON object"});
        continue;
      }
    }
    exportable.push(capture);
  }
  if (exportable.length === 0) {
    return {
      run_id: runId,
      branch_root: path.join(exportRoot, branch),
      exported: [],
      not_exportable: notExportable,
      response_count: 0,
    };
  }

  const identityBranchRoot =
    identityCorpusRoot === null ? null : path.join(identityCorpusRoot, branch);
  const run = new ExportRun({exportRoot, branch, site, runId, profile, startedAt});
  const index = loadIndex(run.branchRoot);
  const exported = [];

  for (const capture of exportable) {
    const payload = capture.payload;
    const fullname = payload.fullname;
    const receivedAt = capture.received_at ?? startedAt;
    const canonicalPayload = canonicalizeCaptureValue(payload, "payload", []);
    const metaPayload =
      capture.meta_payload ?? deriveMetaProjection(canonicalPayload);
    const canonicalMetaPayload = canonicalizeCaptureValue(metaPayload, "payload", []);

    const metaReference = run.recordResponse({
      method: "pages.get_meta",
      request: {site, pages: [fullname]},
      payload: canonicalMetaPayload,
      receivedAt,
    });
    const pageReference = run.recordResponse({
      method: "pages.get_one",
      request: {site, page: fullname},
      payload: canonicalPayload,
      receivedAt,
    });
    const captureId = sha256Hex(
      `${metaReference.payload_sha256}|${pageReference.payload_sha256}`,
    );
    const contentSha256 = `sha256:${sha256Hex(Buffer.from(payload.content, "utf8"))}`;
    const meta = deriveMetaProjection(canonicalPayload);

    const entityId =
      resolveEntityId({branchRoot: run.branchRoot, identityBranchRoot, site, fullname}) ??
      crypto.randomUUID();

    const changeKinds = classifyChange(run.branchRoot, fullname, meta, contentSha256);

    const pageDir = path.join(run.branchRoot, "pages", fullname);
    fs.mkdirSync(pageDir, {recursive: true});
    atomicWriteBytes(path.join(pageDir, "source.wikidot.txt"), Buffer.from(payload.content, "utf8"));
    atomicWriteBytes(path.join(pageDir, "meta.json"), prettyCorpusJsonBytes(meta));
    atomicWriteBytes(path.join(pageDir, "entity_id.txt"), Buffer.from(`${entityId}\n`, "utf8"));
    atomicWriteBytes(path.join(pageDir, "api-response.json"), canonicalCorpusJsonBytes(canonicalPayload));
    atomicWriteBytes(path.join(pageDir, "html.xmlrpc.html"), Buffer.from(payload.html, "utf8"));

    const snapshot = {
      schema_version: 1,
      capture_id: captureId,
      run_id: runId,
      observed_at: receivedAt,
      fullname,
      entity_id: entityId,
      get_meta_response: metaReference,
      get_one_response: pageReference,
      content_sha256: contentSha256,
    };
    const snapshotPath = path.join(
      run.branchRoot, "by-uuid", entityId, "snapshots", `${captureId}.json`,
    );
    writeImmutableBytes(snapshotPath, canonicalCorpusJsonBytes(snapshot), "page snapshot");

    const current = {
      schema_version: 1,
      run_id: runId,
      entity_id: entityId,
      capture_id: captureId,
      payload_sha256: pageReference.payload_sha256,
      fullname,
      status: "active",
    };
    atomicWriteBytes(path.join(pageDir, "current.json"), canonicalCorpusJsonBytes(current));

    if (changeKinds.length > 0) {
      const observation = {
        obs_id: crypto.randomUUID(),
        observed_at: receivedAt,
        run_id: runId,
        change_kinds: changeKinds,
        fullname,
        title: meta.title,
        created_by: typeof meta.created_by === "string" ? meta.created_by : "",
        updated_at: meta.updated_at,
        content_sha256: contentSha256,
        rating: Number.isInteger(meta.rating) ? meta.rating : null,
        revisions: Number.isInteger(meta.revisions) ? meta.revisions : null,
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        status: "active",
      };
      const observationsPath = path.join(
        run.branchRoot, "by-uuid", entityId, "observations.ndjson",
      );
      fs.mkdirSync(path.dirname(observationsPath), {recursive: true});
      fs.appendFileSync(observationsPath, observationLineBytes(observation));
    }

    upsertIndexEntity(index, {
      entityId, site, meta, contentSha256, observedAt: receivedAt, runId,
    });
    run.writeManifest({status: "running"});
    exported.push({fullname, entity_id: entityId, capture_id: captureId});
  }

  atomicWriteBytes(path.join(run.branchRoot, "index.json"), prettyCorpusJsonBytes(index));
  run.writeManifest({
    status: "targeted",
    exit_code: 0,
    finished_at: finishedAt ?? new Date().toISOString(),
    counts: {
      pages_committed: exported.length,
      pages_not_exportable: notExportable.length,
      responses: run.responseCount,
    },
    complete_gate: {targeted_scope: true, no_failures: true, no_pending: true},
  });

  return {
    run_id: runId,
    branch_root: run.branchRoot,
    exported,
    not_exportable: notExportable,
    response_count: run.responseCount,
  };
}

export function readStoredCorpusCapture(corpusRoot, branch, fullname) {
  assertSafeBranch(branch);
  assertSafePageFullname(fullname);
  const branchRoot = path.join(corpusRoot, branch);
  const pageDir = path.join(branchRoot, "pages", fullname);
  if (!fs.existsSync(pageDir)) {
    return {ok: false, fullname, reason: "page is not present in the stored corpus"};
  }
  const apiResponsePath = path.join(pageDir, "api-response.json");
  if (!fs.existsSync(apiResponsePath)) {
    return {
      ok: false,
      fullname,
      reason: "no stored raw capture (api-response.json missing); stored form is a digested projection",
    };
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(apiResponsePath, "utf8"));
  } catch (error) {
    return {ok: false, fullname, reason: `stored api-response.json is unreadable: ${error.message}`};
  }
  const problem = rawCapturePayloadProblem(payload);
  if (problem !== null) {
    return {ok: false, fullname, reason: `stored api-response.json is not a raw capture: ${problem}`};
  }

  let metaPayload = null;
  let receivedAt = null;
  const current = readJsonIfExists(path.join(pageDir, "current.json"));
  if (current !== null && typeof current.capture_id === "string" && typeof current.entity_id === "string") {
    const snapshot = readJsonIfExists(
      path.join(branchRoot, "by-uuid", current.entity_id, "snapshots", `${current.capture_id}.json`),
    );
    if (snapshot !== null) {
      receivedAt = typeof snapshot.observed_at === "string" ? snapshot.observed_at : null;
      const objectPath = snapshot.get_meta_response?.object_path;
      if (typeof objectPath === "string") {
        const metaObject = readJsonIfExists(path.join(branchRoot, objectPath));
        if (metaObject !== null) metaPayload = metaObject;
      }
    }
  }
  return {
    ok: true,
    capture: {
      fullname,
      transport: "stored-capture",
      received_at: receivedAt,
      payload,
      meta_payload: metaPayload,
    },
  };
}

export function listStoredCorpusPages(corpusRoot, branch) {
  assertSafeBranch(branch);
  const pagesDir = path.join(corpusRoot, branch, "pages");
  if (!fs.existsSync(pagesDir)) return [];
  return fs
    .readdirSync(pagesDir, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(codePointCompare);
}
