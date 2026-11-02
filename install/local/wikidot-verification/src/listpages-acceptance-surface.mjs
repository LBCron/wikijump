export const LISTPAGES_ACCEPTANCE_DEPENDENCY_SURFACE_SCHEMA =
  "wikijump_listpages_compat.acceptance_dependency_surface.v1";

export const LISTPAGES_ACCEPTANCE_RENDER_SOURCE_PATHS = Object.freeze([
  "deepwell/src/services/page_query/",
  "deepwell/src/services/render/",
  "deepwell/src/services/view/module_arguments.rs",
  "deepwell/src/services/view/module_render.rs",
]);

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalEqual(left, right) {
  return JSON.stringify(canonicalize(left)) ===
    JSON.stringify(canonicalize(right));
}

function validateDependencySurface(surface, label) {
  if (surface === null || typeof surface !== "object") {
    throw new Error(`${label} is missing`);
  }
  if (
    !Array.isArray(surface.render_source_paths) ||
    surface.render_source_paths.length === 0 ||
    surface.render_source_paths.some((path) => typeof path !== "string")
  ) {
    throw new Error(`${label}.render_source_paths is invalid`);
  }
  if (!SHA1.test(surface.ftml_revision ?? "")) {
    throw new Error(`${label}.ftml_revision is invalid`);
  }
  if (!SHA256.test(surface.dependency_lock_sha256 ?? "")) {
    throw new Error(`${label}.dependency_lock_sha256 is invalid`);
  }
  const fixturePlane = surface.fixture_plane;
  if (fixturePlane === null || typeof fixturePlane !== "object") {
    throw new Error(`${label}.fixture_plane is missing`);
  }
  for (const key of [
    "runtime_identity_sha256",
    "runtime_proof_sha256",
    "runtime_observation_stable_sha256",
  ]) {
    if (!SHA256.test(fixturePlane[key] ?? "")) {
      throw new Error(`${label}.fixture_plane.${key} is invalid`);
    }
  }
  if (
    fixturePlane.service_image_sha256 === null ||
    typeof fixturePlane.service_image_sha256 !== "object" ||
    Object.values(fixturePlane.service_image_sha256).some(
      (value) => !SHA256.test(value ?? ""),
    )
  ) {
    throw new Error(`${label}.fixture_plane.service_image_sha256 is invalid`);
  }
  if (
    fixturePlane.service_host_port === null ||
    typeof fixturePlane.service_host_port !== "object" ||
    Object.values(fixturePlane.service_host_port).some(
      (value) => !Number.isInteger(value) || value < 1 || value > 65535,
    )
  ) {
    throw new Error(`${label}.fixture_plane.service_host_port is invalid`);
  }
}

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

export function listPagesAcceptanceRenderPaths(changedPaths) {
  if (!Array.isArray(changedPaths)) {
    throw new Error("changed paths must be an array");
  }
  return [...new Set(changedPaths.map((path) => normalizePath(path)))].filter(
    (path) =>
      LISTPAGES_ACCEPTANCE_RENDER_SOURCE_PATHS.some(
        (prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix),
      ),
  ).sort();
}

export function attestUntouchedListPagesAcceptanceSurface({
  baseRevision,
  headRevision,
  changedPaths,
  previousSurface,
  currentSurface,
  priorReceiptSha256,
}) {
  if (!SHA1.test(baseRevision ?? "") || !SHA1.test(headRevision ?? "")) {
    throw new Error("acceptance attestation revisions are invalid");
  }
  if (!SHA256.test(priorReceiptSha256 ?? "")) {
    throw new Error("acceptance attestation prior receipt hash is invalid");
  }
  validateDependencySurface(previousSurface, "previous dependency surface");
  validateDependencySurface(currentSurface, "current dependency surface");
  const normalizedChangedPaths = [...new Set(changedPaths.map(normalizePath))].sort();
  const renderPathsTouched = listPagesAcceptanceRenderPaths(normalizedChangedPaths);
  if (renderPathsTouched.length > 0) {
    throw new Error(
      "ListPages acceptance requires a fresh authoritative ListPages replay after changed render source paths",
    );
  }
  if (!canonicalEqual(previousSurface, currentSurface)) {
    throw new Error(
      "ListPages acceptance dependency surface changed; a fresh authoritative replay is required",
    );
  }
  return {
    schema: LISTPAGES_ACCEPTANCE_DEPENDENCY_SURFACE_SCHEMA,
    mode: "untouched-render-surface",
    base_revision: baseRevision,
    head_revision: headRevision,
    changed_paths: normalizedChangedPaths,
    render_paths_touched: renderPathsTouched,
    prior_receipt_sha256: priorReceiptSha256,
    dependency_surface: structuredClone(currentSurface),
  };
}
