import adapter from "@sveltejs/adapter-node"
import { rmSync, statSync } from "fs"
import { tmpdir } from "os"
import { dirname, resolve } from "path"
import { sveltePreprocess } from "svelte-preprocess"
import { fileURLToPath } from "url"
import {
  csrfTrustedOrigins,
  parseDeploymentEnvironment
} from "./src/lib/server/deployment-environment.ts"
import { auditedExternalAssetOrigins } from "./src/lib/server/audited-external-asset-origins.ts"
import {
  LOCAL_MIRROR_FILE_ASSET_SITES,
  platformDomains,
  platformHttpsOrigin
} from "./src/lib/server/platform-domains.ts"

// The former only works on node 20.11+
const __dirname = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url))

function resolveAssets() {
  try {
    let globalAssets = statSync(resolve(__dirname, "../assets"))
    if (globalAssets.isDirectory()) return resolve(__dirname, "../assets")
    else return resolve(__dirname, "src/assets")
  } catch (error) {
    return resolve(__dirname, "src/assets")
  }
}

/**
 * @typedef {NonNullable<
 *   NonNullable<
 *     NonNullable<import("@sveltejs/kit").Config["kit"]>["csp"]
 *   >["directives"]
 * >} CspDirectives
 */
/** @typedef {NonNullable<CspDirectives["img-src"]>} CspSources */

const CURRENT_SITE_FILE_ORIGIN = "https://wikijump-current-site.invalid"
/** @type {CspSources} */
const WIKIDOT_LEGACY_IMAGE_SOURCES = ["https://d3g0gp89917ko0.cloudfront.net"]
/** @type {CspSources} */
const WIKIDOT_LEGACY_SCRIPT_SOURCES = []
/** @type {CspSources} */
// The read-only local mirrors (LOCAL_MIRROR_FILE_ASSET_SITES in
// platform-domains.js) are this local environment's own file hosts
// (standing: `scp-wiki.wjfiles.localhost`; local development:
// `scp-wiki.wjfiles.dev.localhost:18443`).
const LOCAL_SCP_FILE_ASSET_SITES = LOCAL_MIRROR_FILE_ASSET_SITES
/** @type {CspSources} */
const WIKIDOT_IMAGE_SOURCES = [
  "https://scp-wiki.wikidot.com",
  "https://www.wikidot.com",
  "https://scp-jp-storage.wikidot.com",
  "https://scpsandboxcn.wikidot.com",
  "https://*.wdfiles.com",
  "https://cdn.scpwiki.com",
  "https://scp-wiki-cdn.nyc3.cdn.digitaloceanspaces.com",
  "https://d2qhngyckgiutd.cloudfront.net",
  // Header logos and decorative images that theme stylesheets reference from
  // their GitHub Pages hosts and from Wikimedia Commons. Live Wikidot loads
  // each (retained observations:
  // install/local/wikidot-verification/artifacts/theme-sweep-external-origins-20261019.json
  // and, for the SCP-JP host,
  // install/local/wikidot-verification/artifacts/scp-jp-external-origins-20261025.json).
  "https://nu-scptheme.github.io",
  "https://scp-jp.github.io",
  "https://scpwiki.github.io",
  "https://upload.wikimedia.org"
]
/** @type {CspSources} */
const WIKIDOT_MEDIA_FRAME_SOURCES = ["https://www.youtube.com", "https://embed.acast.com"]
// External stylesheet and font origins are not maintained inline: they come
// from the audited registry so every allowlisted origin carries its own
// retained provenance and the policy can never be widened by an
// author-supplied `@import` URL.
const WIKIDOT_STYLE_SOURCES = auditedExternalAssetOrigins("styles")
const WIKIDOT_FONT_SOURCES = auditedExternalAssetOrigins("fonts")

const deploymentEnvironment = parseDeploymentEnvironment()
const domains = platformDomains({ deploymentEnvironment })
const LOCAL_SCP_FILE_ASSET_SOURCES = /** @type {CspSources} */ (
  LOCAL_SCP_FILE_ASSET_SITES.map((site) =>
    platformHttpsOrigin(`${site}.${domains.files}`, domains)
  )
)
const testOutDir = process.env.NODE_TEST_CONTEXT
  ? resolve(tmpdir(), `wikijump-framerail-svelte-kit-test-${process.pid}`)
  : null

if (testOutDir) {
  process.on("exit", () => rmSync(testOutDir, { recursive: true, force: true }))
}

/** @returns {CspSources} */
function imageSources() {
  /** @type {CspSources} */
  const sources = [
    "self",
    "data:",
    "blob:",
    CURRENT_SITE_FILE_ORIGIN,
    ...WIKIDOT_IMAGE_SOURCES
  ]

  if (deploymentEnvironment === "local") {
    sources.push(...LOCAL_SCP_FILE_ASSET_SOURCES)
    sources.push(...WIKIDOT_LEGACY_IMAGE_SOURCES)
  }

  return sources
}

/** @returns {CspSources} */
function styleSources() {
  /** @type {CspSources} */
  const sources = [
    "self",
    "unsafe-inline",
    CURRENT_SITE_FILE_ORIGIN,
    ...WIKIDOT_STYLE_SOURCES
  ]
  if (deploymentEnvironment === "local") sources.push(...LOCAL_SCP_FILE_ASSET_SOURCES)
  return sources
}

/** @returns {CspSources} */
function fontSources() {
  // The viewed site's own files host serves the site theme's @font-face
  // payload (e.g. Sigma-10), exactly as it serves its styles and images:
  // materializeSiteCsp replaces this placeholder with the canonical and
  // request-port forms per response. Without it, font-src carries only the
  // mirror origins while style-src and img-src admit the viewed site.
  /** @type {CspSources} */
  const sources = ["self", "data:", CURRENT_SITE_FILE_ORIGIN, ...WIKIDOT_FONT_SOURCES]
  if (deploymentEnvironment === "local") sources.push(...LOCAL_SCP_FILE_ASSET_SOURCES)
  return sources
}

/** @returns {CspSources} */
function scriptSources() {
  return ["self", ...WIKIDOT_LEGACY_SCRIPT_SOURCES]
}

/** @returns {CspSources} */
function frameSources() {
  // The [[html]] block fallback iframe is emitted with a same-origin src
  // (`/<slug>/html/<n>`) that redirects to the site's file origin, where the
  // block is hosted. Chromium re-checks frame-src on every redirect hop, so
  // without the per-site file origin (materialized per response by
  // `materializeSiteCsp`) every html block fails with `ERR_BLOCKED_BY_CSP`.
  // YouTube/Acast remain the only external embeds.
  return ["self", CURRENT_SITE_FILE_ORIGIN, ...WIKIDOT_MEDIA_FRAME_SOURCES]
}

/**
 * Options for the `sveltekit()` Vite plugin (SvelteKit 3 no longer reads
 * `svelte.config.js`). Kept in a plain module, rather than inline in
 * `vite.config.ts`, so the CSP/CSRF policy tests can import it without
 * loading Vite.
 *
 * @type {NonNullable<import("@sveltejs/kit").Config["kit"]>}
 */
const options = {
  // Consult https://github.com/sveltejs/svelte-preprocess
  // for more information about preprocessors
  preprocess: sveltePreprocess(),
  adapter: adapter(),
  ...(testOutDir ? { outDir: testOutDir } : {}),
  csrf: {
    trustedOrigins: csrfTrustedOrigins({ deploymentEnvironment })
  },
  csp: {
    mode: "auto",
    directives: {
      "default-src": ["self"],
      "base-uri": ["self"],
      "object-src": ["none"],
      "frame-ancestors": ["none"],
      "form-action": ["self"],
      "img-src": imageSources(),
      "font-src": fontSources(),
      "style-src": styleSources(),
      "script-src": scriptSources(),
      "frame-src": frameSources(),
      "connect-src": ["self"],
      "worker-src": ["self", "blob:"],
      "manifest-src": ["self"],
      "upgrade-insecure-requests": true
    }
  },
  alias: {
    // SvelteKit 3 removed the built-in $lib alias (module_removed_lib); keep it
    // rather than rewriting every import to #lib.
    "$lib": resolve(__dirname, "src/lib"),
    "$static": resolve(__dirname, "static"),
    "$assets": resolveAssets()
  }
}

export default options
