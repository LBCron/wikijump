import fs from "node:fs/promises";

import {
  canonicalDom,
  sha256,
  validateWikidotReference,
  visibleText,
} from "./syntax-differential.mjs";
import {localCanonicalDom, localVisibleText} from "./local-output-comparison.mjs";
import {
  observeListPagesRuntimeAuthority,
  validateListPagesRuntimeObservation,
} from "./listpages-runtime-authority.mjs";
import {
  publishListPagesJsonNoReplace,
} from "./listpages-evidence-publication.mjs";
import {deepwellRpcAuthorization} from "./deepwell-rpc-auth.mjs";
import {validateLocalDeepwellRpcUrl} from "./theme-localization-deepwell-adapter.mjs";

export const LISTPAGES_PREVIEW_DIFFERENTIAL_SCHEMA =
  "wikijump_listpages_compat.preview_differential.v1";
export const DEFAULT_LISTPAGES_RPC_TIMEOUT_MS = 30_000;
export const MAX_LISTPAGES_RPC_TIMEOUT_MS = 120_000;
export const LISTPAGES_REPLAY_RUNTIME_IDENTITY_SCHEMA =
  "wikijump_listpages_compat.authoritative_runtime_identity.v1";
export const LISTPAGES_REPLAY_RUNTIME_PROOF_SCHEMA =
  "wikijump_listpages_compat.running_candidate_proof.v1";

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REQUIRED_SERVICES = ["cache", "database", "deepwell", "files"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateListPagesRuntimeIdentity(identity) {
  if (identity?.schema !== LISTPAGES_REPLAY_RUNTIME_IDENTITY_SCHEMA) {
    throw new Error("runtime identity schema is unsupported");
  }
  for (const field of ["wikijump_sha", "wikijump_tree", "ftml_sha"]) {
    if (!GIT_SHA_PATTERN.test(identity[field] ?? "")) {
      throw new Error(`runtime identity ${field} is invalid`);
    }
  }
  for (const field of [
    "dependency_lock_sha256",
    "build_manifest_sha256",
    "executable_sha256",
    "runtime_config_sha256",
    "runtime_environment_sha256",
  ]) {
    if (!SHA256_PATTERN.test(identity[field] ?? "")) {
      throw new Error(`runtime identity ${field} is invalid`);
    }
  }
  if (typeof identity.profile !== "string" || identity.profile.trim() === "") {
    throw new Error("runtime identity profile is invalid");
  }
  if (
    typeof identity.build_artifact_key !== "string" ||
    !/^candidate-v3-[0-9a-f]{64}$/u.test(identity.build_artifact_key)
  ) {
    throw new Error("runtime identity build_artifact_key is invalid");
  }
  let rpcUrl;
  try {
    rpcUrl = new URL(identity.rpc_url);
  } catch {
    throw new Error("runtime identity rpc_url is invalid");
  }
  if (
    rpcUrl.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(rpcUrl.hostname) ||
    rpcUrl.username ||
    rpcUrl.password ||
    rpcUrl.search ||
    rpcUrl.hash
  ) {
    throw new Error("runtime identity rpc_url must be loopback HTTP");
  }
  if (
    typeof identity.site_slug !== "string" ||
    identity.site_slug.trim() === "" ||
    !Number.isSafeInteger(identity.site_id) ||
    identity.site_id < 1
  ) {
    throw new Error("runtime identity site is invalid");
  }
  if (!isRecord(identity.service_image_sha256)) {
    throw new Error("runtime identity service image identities are invalid");
  }
  if (!isRecord(identity.service_host_port)) {
    throw new Error("runtime identity service host ports are invalid");
  }
  const serviceNames = Object.keys(identity.service_image_sha256).sort();
  if (
    serviceNames.length !== REQUIRED_SERVICES.length ||
    serviceNames.some((name, index) => name !== REQUIRED_SERVICES[index])
  ) {
    throw new Error(
      `runtime identity services must be exactly ${REQUIRED_SERVICES.join(", ")}`,
    );
  }
  for (const service of REQUIRED_SERVICES) {
    if (!SHA256_PATTERN.test(identity.service_image_sha256[service] ?? "")) {
      throw new Error(`runtime identity ${service} image is invalid`);
    }
  }
  const runtimeServices = REQUIRED_SERVICES.filter(
    (service) => service !== "deepwell",
  );
  if (
    JSON.stringify(Object.keys(identity.service_host_port).sort()) !==
      JSON.stringify(runtimeServices)
  ) {
    throw new Error(
      `runtime identity host ports must be exactly ${runtimeServices.join(", ")}`,
    );
  }
  for (const service of runtimeServices) {
    const port = identity.service_host_port[service];
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error(`runtime identity ${service} host port is invalid`);
    }
  }
  if (
    identity.service_image_sha256.deepwell !== identity.executable_sha256
  ) {
    throw new Error(
      "runtime identity Deepwell image differs from executable identity",
    );
  }
  return identity;
}

export function validateListPagesRuntimeProof(proof, identity) {
  if (proof?.schema !== LISTPAGES_REPLAY_RUNTIME_PROOF_SCHEMA) {
    throw new Error("runtime proof schema is unsupported");
  }
  if (
    typeof proof.observed_at !== "string" ||
    Number.isNaN(Date.parse(proof.observed_at))
  ) {
    throw new Error("runtime proof observation time is invalid");
  }
  if (!SHA256_PATTERN.test(proof.run_nonce ?? "")) {
    throw new Error("runtime proof run nonce is invalid");
  }
  const expectedCandidate = {
    wikijump_sha: identity.wikijump_sha,
    wikijump_tree: identity.wikijump_tree,
    ftml_sha: identity.ftml_sha,
    dependency_lock_sha256: identity.dependency_lock_sha256,
    build_manifest_sha256: identity.build_manifest_sha256,
    build_artifact_key: identity.build_artifact_key,
    executable_sha256: identity.executable_sha256,
    runtime_config_sha256: identity.runtime_config_sha256,
    runtime_environment_sha256: identity.runtime_environment_sha256,
    profile: identity.profile,
  };
  for (const [field, expected] of Object.entries(expectedCandidate)) {
    if (proof.candidate?.[field] !== expected) {
      throw new Error(`runtime proof ${field} differs from runtime identity`);
    }
  }
  for (const [field, expected] of [
    ["rpc_url", identity.rpc_url],
    ["site_slug", identity.site_slug],
    ["site_id", identity.site_id],
  ]) {
    if (proof[field] !== expected) {
      throw new Error(`runtime proof ${field} differs from runtime identity`);
    }
  }
  if (!isRecord(proof.service_image_sha256)) {
    throw new Error("runtime proof service image identities are invalid");
  }
  if (
    Object.keys(identity.service_host_port).some(
      (service) =>
        proof.service_host_port?.[service] !==
        identity.service_host_port[service],
    ) ||
    Object.keys(proof.service_host_port ?? {}).length !==
      Object.keys(identity.service_host_port).length
  ) {
    throw new Error(
      "runtime proof service host ports differ from runtime identity",
    );
  }
  for (const service of REQUIRED_SERVICES) {
    if (
      proof.service_image_sha256[service] !==
      identity.service_image_sha256[service]
    ) {
      throw new Error(
        `runtime proof ${service} image differs from runtime identity`,
      );
    }
  }
  return proof;
}

async function loadRuntimeAuthority({
  authoritative,
  runtimeIdentityPath,
  runtimeProofPath,
  rpcUrl,
  siteSlug,
}) {
  if (authoritative && (!runtimeIdentityPath || !runtimeProofPath)) {
    throw new Error(
      "authoritative preview requires --runtime-identity and --runtime-proof",
    );
  }
  if (!runtimeIdentityPath) {
    return {
      mode: "diagnostic",
      completion_eligible: false,
      identity: null,
      identity_sha256: null,
      proof_sha256: null,
      proof: null,
    };
  }
  const identityText = await fs.readFile(runtimeIdentityPath, "utf8");
  const identity = validateListPagesRuntimeIdentity(JSON.parse(identityText));
  if (!authoritative) {
    return {
      mode: "diagnostic",
      completion_eligible: false,
      identity,
      identity_sha256: sha256(identityText),
      proof_sha256: null,
      proof: null,
    };
  }
  if (identity.rpc_url !== rpcUrl || identity.site_slug !== siteSlug) {
    throw new Error(
      "runtime identity endpoint or site differs from runner arguments",
    );
  }
  const proofText = await fs.readFile(runtimeProofPath, "utf8");
  const proof = validateListPagesRuntimeProof(JSON.parse(proofText), identity);
  return {
    mode: "authoritative",
    completion_eligible: true,
    identity,
    identity_sha256: sha256(identityText),
    proof_sha256: sha256(proofText),
    proof,
  };
}

export class DeepwellJsonRpcClient {
  #authorization;

  constructor({
    rpcUrl,
    rpcToken,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_LISTPAGES_RPC_TIMEOUT_MS,
  }) {
    validateRpcTimeout(timeoutMs);
    this.rpcUrl = validateLocalDeepwellRpcUrl(rpcUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.#authorization = deepwellRpcAuthorization(rpcToken);
    this.nextId = 1;
  }

  async call(method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    const requestId = this.nextId++;
    try {
      response = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        redirect: "error",
        headers: { authorization: this.#authorization, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`JSON-RPC ${method} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const body = JSON.parse(text);
    if (body?.jsonrpc !== "2.0" || body.id !== requestId) {
      throw new Error(
        `JSON-RPC ${method} returned a mismatched protocol version or response ID`,
      );
    }
    if (body.error) {
      throw new Error(`JSON-RPC ${method} error: ${JSON.stringify(body.error)}`);
    }
    return body.result;
  }
}

function validateRpcTimeout(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_LISTPAGES_RPC_TIMEOUT_MS
  ) {
    throw new Error(
      `preview differential RPC timeout must be an integer from 1 through ${MAX_LISTPAGES_RPC_TIMEOUT_MS}`,
    );
  }
  return value;
}

function readJsonlText(text) {
  if (!text.trim()) return [];
  return text.trimEnd().split(/\r?\n/u).map((line) => JSON.parse(line));
}

function validateConcurrency(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new Error("preview differential concurrency must be an integer from 1 through 32");
  }
  return value;
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export function compareListPagesPreviewHtml(reference, localHtml) {
  const liveHtml = reference.raw_html;
  const liveDom = canonicalDom(liveHtml);
  const localDom = localCanonicalDom(localHtml);
  const domMatches = JSON.stringify(liveDom) === JSON.stringify(localDom);
  const liveVisibleText = visibleText(liveHtml);
  const localText = localVisibleText(localHtml);
  const textMatches = liveVisibleText === localText;
  return {
    status: domMatches && textMatches ? "match" : "mismatch",
    checks: {
      dom_tree: {
        status: domMatches ? "match" : "mismatch",
        ...(domMatches ? {} : { live: liveDom, local: localDom }),
      },
      visible_text: {
        status: textMatches ? "match" : "mismatch",
        live: liveVisibleText,
        local: localText,
      },
    },
    identities: {
      source_sha256: reference.source_sha256,
      live_html_sha256: reference.raw_html_sha256,
      local_html_sha256: sha256(localHtml),
    },
  };
}

export async function runListPagesPreviewDifferential({
  referencesPath,
  runtimeIdentityPath = null,
  runtimeProofPath = null,
  authoritative = false,
  rpcUrl,
  siteSlug,
  rpcClient = null,
  rpcTimeoutMs = DEFAULT_LISTPAGES_RPC_TIMEOUT_MS,
  concurrency = 8,
  observeRuntime = observeListPagesRuntimeAuthority,
}) {
  concurrency = validateConcurrency(concurrency);
  rpcTimeoutMs = validateRpcTimeout(rpcTimeoutMs);
  rpcClient ??= new DeepwellJsonRpcClient({ rpcUrl, timeoutMs: rpcTimeoutMs });
  const referencesText = await fs.readFile(referencesPath, "utf8");
  const references = readJsonlText(referencesText).map(validateWikidotReference);
  const referenceIds = new Set();
  for (const reference of references) {
    const caseId = reference.syntax_case.case_id;
    if (referenceIds.has(caseId)) {
      throw new Error(`duplicate live reference case ID ${caseId}`);
    }
    referenceIds.add(caseId);
  }
  if (authoritative && references.length === 0) {
    throw new Error("authoritative preview references must not be empty");
  }
  const runtimeAuthority = await loadRuntimeAuthority({
    authoritative,
    runtimeIdentityPath,
    runtimeProofPath,
    rpcUrl,
    siteSlug,
  });
  const runtimeIdentity = runtimeAuthority.identity;
  let runtimeObservationBefore = null;
  if (runtimeAuthority.completion_eligible) {
    runtimeObservationBefore = validateListPagesRuntimeObservation(
      await observeRuntime({
        identity: runtimeIdentity,
        proof: runtimeAuthority.proof,
        phase: "before",
      }),
      "before",
      runtimeIdentity,
      runtimeAuthority.proof,
    );
  }
  const site = await rpcClient.call("site_get", { site: siteSlug });
  if (!Number.isSafeInteger(site?.site_id)) {
    throw new Error(`local site lookup did not return a site_id for ${siteSlug}`);
  }
  if (
    runtimeAuthority.completion_eligible &&
    (
      site.site_id !== runtimeIdentity.site_id ||
      site.slug !== runtimeIdentity.site_slug
    )
  ) {
    throw new Error("running site identity differs from authoritative runtime proof");
  }

  const cases = await mapWithConcurrency(references, concurrency, async (reference) => {
    const syntaxCase = reference.syntax_case;
    let result;
    try {
      const preview = await rpcClient.call("wikidot_page_preview", {
        site_id: site.site_id,
        title: syntaxCase.title,
        wikitext: syntaxCase.source,
      });
      if (!preview || typeof preview.body !== "string") {
        throw new Error("local preview returned no body");
      }
      result = {
        schema: `${LISTPAGES_PREVIEW_DIFFERENTIAL_SCHEMA}.case`,
        case_id: syntaxCase.case_id,
        status: null,
        live: {
          html_sha256: reference.raw_html_sha256,
          visible_text: visibleText(reference.raw_html),
        },
        local: {
          raw_html: preview.body,
          html_sha256: sha256(preview.body),
          visible_text: localVisibleText(preview.body),
          styles: Array.isArray(preview.styles) ? preview.styles : [],
        },
        comparison: compareListPagesPreviewHtml(reference, preview.body),
      };
      result.status = result.comparison.status;
    } catch (error) {
      result = {
        schema: `${LISTPAGES_PREVIEW_DIFFERENTIAL_SCHEMA}.case`,
        case_id: syntaxCase.case_id,
        status: "local-error",
        error: error instanceof Error ? error.message : String(error),
        live: {
          html_sha256: reference.raw_html_sha256,
          visible_text: visibleText(reference.raw_html),
        },
        comparison: {
          identities: {
            source_sha256: reference.source_sha256,
            live_html_sha256: reference.raw_html_sha256,
          },
        },
      };
    }
    return result;
  });

  const counts = {};
  for (const row of cases) counts[row.status] = (counts[row.status] ?? 0) + 1;
  let runtimeObservationAfter = null;
  if (runtimeAuthority.completion_eligible) {
    runtimeObservationAfter = validateListPagesRuntimeObservation(
      await observeRuntime({
        identity: runtimeIdentity,
        proof: runtimeAuthority.proof,
        phase: "after",
      }),
      "after",
      runtimeIdentity,
      runtimeAuthority.proof,
    );
    if (
      runtimeObservationAfter.stable_sha256 !==
      runtimeObservationBefore.stable_sha256
    ) {
      throw new Error("runtime identity changed during preview replay");
    }
  }
  return {
    schema: LISTPAGES_PREVIEW_DIFFERENTIAL_SCHEMA,
    generated_at: new Date().toISOString(),
    inputs: {
      references_path: referencesPath,
      references_sha256: sha256(referencesText),
      runtime_identity_path: runtimeIdentityPath,
      runtime_identity_sha256: runtimeAuthority.identity_sha256,
      runtime_proof_path: runtimeProofPath,
      runtime_proof_sha256: runtimeAuthority.proof_sha256,
      authority: {
        mode: runtimeAuthority.mode,
        completion_eligible: runtimeAuthority.completion_eligible,
        ...(runtimeAuthority.completion_eligible
          ? {
              runtime_observation_before_sha256: sha256(
                JSON.stringify(runtimeObservationBefore),
              ),
              runtime_observation_after_sha256: sha256(
                JSON.stringify(runtimeObservationAfter),
              ),
              runtime_observation_stable_sha256:
                runtimeObservationAfter.stable_sha256,
            }
          : {}),
      },
      rpc_url: rpcUrl,
      site_slug: siteSlug,
      concurrency,
      rpc_timeout_ms: rpcTimeoutMs,
      local_site: { slug: site.slug, site_id: site.site_id },
    },
    runtime_identity: runtimeIdentity,
    runtime_observations: runtimeAuthority.completion_eligible
      ? {
          before: runtimeObservationBefore,
          after: runtimeObservationAfter,
        }
      : null,
    cases,
    summary: {
      total: cases.length,
      counts,
      exit_code: (counts.mismatch ?? 0) > 0 ||
          (counts["local-error"] ?? 0) > 0
        ? 1
        : runtimeAuthority.completion_eligible
          ? 0
          : 2,
    },
  };
}

export async function writePreviewDifferential(verdict, outputPath) {
  await publishListPagesJsonNoReplace(outputPath, verdict);
}
