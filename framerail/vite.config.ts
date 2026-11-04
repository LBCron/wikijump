import pkg from "./package.json" with { type: "json" }

import { sveltekit } from "@sveltejs/kit/vite"
import { execSync } from "child_process"
import { rmSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"

import type { UserConfig } from "vite"

import svelteKitOptions from "./sveltekit-options.ts"

const pnpmVersion = pkg.packageManager?.startsWith("pnpm@")
  ? pkg.packageManager.slice("pnpm@".length)
  : null

// The commit this frontend was built from, when the build runs inside
// a git checkout. Deployed builds may not have one; the platform
// information page (WJ-1279) omits the row when it is absent.
let frontendGitCommit: string | null = process.env.WIKIJUMP_GIT_COMMIT || null
if (!frontendGitCommit) {
  try {
    frontendGitCommit =
      execSync("git rev-parse HEAD", { encoding: "utf8" }).trim() || null
  } catch {
    frontendGitCommit = null
  }
}

const testCacheDir =
  process.env.NODE_TEST_CONTEXT || process.env.FRAMERAIL_VITE_TEST_CACHE
    ? resolve(tmpdir(), `wikijump-framerail-vite-test-${process.pid}`)
    : null

if (testCacheDir) {
  process.on("exit", () => rmSync(testCacheDir, { recursive: true, force: true }))
}

const config: UserConfig = {
  ...(testCacheDir ? { cacheDir: testCacheDir } : {}),
  server: {
    host: "::",
    port: 3393,
    strictPort: true,

    // This setting was added to avoid a security issue:
    // https://github.com/vitejs/vite/security/advisories/GHSA-vg6x-rcgg-rjx6
    //
    // Normally this should be a list but setting it to "true" disables the check.
    // After discussion, this is acceptable because:
    // 1. Vite is only used in development, not in deployed instances.
    // 2. In our stack, Caddy receives requests and reverse proxies them
    //    to our web servers, wws and framerail. The configuration already
    //    handles domain -> site routing logic, so hostile domains are not
    //    able to utilize this configuration field since they will not be
    //    in the generated Caddyfile.
    //
    //    Essentially, caddy is acting as our "allowedHosts" for us.
    allowedHosts: true
  },
  // SvelteKit 3 no longer reads svelte.config.js; the kit/adapter/CSP/CSRF/
  // preprocess options are passed here (see sveltekit-options.ts).
  plugins: [sveltekit(svelteKitOptions)],
  define: {
    // also update $lib/vite-env.d.ts if these defines are changed
    serverInfo: {
      pnpmVersion,
      frontendGitCommit,
      frontendName: pkg.name ?? null,
      frontendVersion: pkg.version ?? null,
      frontendDescription: pkg.description ?? null,
      frontendRepository: pkg.repository ?? null,
      frontendLicense: pkg.license ?? null
    }
  }
}

export default config
