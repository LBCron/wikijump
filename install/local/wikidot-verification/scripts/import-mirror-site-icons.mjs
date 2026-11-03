#!/usr/bin/env node


import crypto from "node:crypto"
import fs from "node:fs/promises"

import { loadPlaywright } from "../src/browser-session.mjs"
import {
  createBrowserRequestGate,
  createBrowserResponseCache,
  defaultPublicEvidenceResponseCacheOptions,
  installBrowserRequestGate
} from "../src/browser-request-gate.mjs"
import { deepwellRpcAuthorization } from "../src/deepwell-rpc-auth.mjs"
import { runCliIfMain } from "../src/cli-entry.mjs"

export const ICON_KINDS = Object.freeze(["favicon", "ios", "windows"])
const ICON_ROUTES = Object.freeze({
  favicon: "/local--favicon/",
  ios: "/local--iosicon/",
  windows: "/local--wp8icon/"
})
const MIMES = new Set(["image/gif", "image/png", "image/x-icon", "image/jpeg"])

function attribute(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu").exec(tag)
  return match ? (match[2] ?? match[3] ?? match[4]) : null
}

export function declaredSiteIcons(html, origin) {
  const head = html.slice(0, Math.max(0, html.search(/<\/head\s*>/iu)) || html.length)
  const icons = { favicon: [], ios: [], windows: [] }
  for (const tag of head.match(/<(?:link|meta)\b[^>]*>/giu) ?? []) {
    const href = attribute(tag, "href") ?? (/msapplication-TileImage/iu.test(tag) ? attribute(tag, "content") : null)
    if (!href) continue
    const url = new URL(href, origin)
    if (url.origin !== new URL(origin).origin) continue
    for (const kind of ICON_KINDS) {
      if (url.pathname.startsWith(ICON_ROUTES[kind])) {
        const sizes = attribute(tag, "sizes")
        const size = sizes ? Number.parseInt(sizes, 10) : 0
        icons[kind].push({ url: url.href, size: Number.isFinite(size) ? size : 0 })
      }
    }
  }
  const chosen = {}
  for (const kind of ICON_KINDS) {
    const candidates = [...new Map(icons[kind].map((icon) => [icon.url, icon])).values()]
    if (candidates.length === 0) continue
    candidates.sort((left, right) => right.size - left.size || left.url.localeCompare(right.url))
    chosen[kind] = candidates[0].url
  }
  return chosen
}

export function iconMime(contentType) {
  const mime = (contentType ?? "").split(";", 1)[0].trim().toLowerCase()
  if (!MIMES.has(mime)) throw new Error(`unsupported site icon media type: ${contentType}`)
  return mime
}

export function sniffIconMime(bytes) {
  const startsWith = (...magic) => magic.every((byte, index) => bytes[index] === byte)
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return "image/png"
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "image/gif"
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg"
  if (startsWith(0x00, 0x00, 0x01, 0x00)) return "image/x-icon"
  throw new Error("site icon bytes do not match a supported image type")
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!["--site", "--source-origin", "--rpc-url", "--session-file", "--cache-dir", "--cache-identity", "--browser-root"].includes(flag) || !value) {
      throw new Error(`unknown or incomplete option: ${flag}`)
    }
    args[flag.slice(2).replace(/-([a-z])/gu, (_, c) => c.toUpperCase())] = value
  }
  for (const name of ["site", "sourceOrigin", "rpcUrl", "sessionFile"]) {
    if (!args[name]) throw new Error(`--${name.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)} is required`)
  }
  if ((args.cacheDir === undefined) !== (args.cacheIdentity === undefined)) {
    throw new Error("--cache-dir and --cache-identity go together")
  }
  return args
}

async function rpc(args, session, method, params) {
  const response = await fetch(args.rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: deepwellRpcAuthorization(),
      "x-deepwell-session-token": session
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  })
  const body = await response.json()
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`)
  return body.result
}

export async function importMirrorSiteIcons(args) {
  const session = JSON.parse(await fs.readFile(args.sessionFile, "utf8")).session_token
  if (!session) throw new Error("session file has no session_token")
  const gate = createBrowserRequestGate({ intervalMs: 0 })
  const responseCache = createBrowserResponseCache({
    ...defaultPublicEvidenceResponseCacheOptions(),
    ...(args.cacheDir ? { persistentDir: args.cacheDir, persistentIdentity: args.cacheIdentity } : {}),
    cacheDocuments: true,
    evidenceReplay: true
  })
  await responseCache.load()
  const { chromium } = loadPlaywright(args.browserRoot)
  const browser = await chromium.launch()
  const fetched = {}
  let declared
  try {
    const context = await browser.newContext({ serviceWorkers: "block" })
    await installBrowserRequestGate(context, { gate, responseCache })
    const page = await context.newPage()
    await page.route("**/*", (route) => {
      const request = route.request()
      return request.resourceType() === "document" && request.frame() === page.mainFrame()
        ? route.fallback()
        : route.abort("blockedbyclient")
    })
    const home = await page.goto(new URL("/", args.sourceOrigin).href, { waitUntil: "commit" })
    if (home?.status() !== 200) throw new Error(`source home answered ${home?.status()}`)
    declared = declaredSiteIcons(await home.text(), args.sourceOrigin)
    for (const [kind, url] of Object.entries(declared)) {
      const response = await page.goto(url, { waitUntil: "commit" })
      if (response?.status() !== 200) throw new Error(`${url} answered ${response?.status()}`)
      // The exact network bytes come from the response cache, not
      // response.body(): Chromium transcodes a document whose content
      // type carries a charset (Wikidot serves these icons as e.g.
      // `image/png; charset=utf-8`), which mangles binary payloads.
      // The request gate retained the untouched bytes for this
      // navigation, keyed by the final URL after any redirects.
      const retained = responseCache.get(response.url()) ?? responseCache.get(url)
      if (!retained) throw new Error(`${url} was not retained by the response cache`)
      const bytes = retained.body
      iconMime(retained.headers["content-type"])
      fetched[kind] = { url, mime: sniffIconMime(bytes), bytes }
    }
    await context.close()
  } finally {
    await browser.close().catch(() => {})
    await gate.flush()
  }

  const results = []
  for (const kind of ICON_KINDS) {
    const icon = fetched[kind]
    const sha256 = icon ? crypto.createHash("sha256").update(icon.bytes).digest("hex") : null
    const params = icon
      ? { site: args.site, kind, ip_address: "127.0.0.1", source: icon.url, mime: icon.mime, data: [...icon.bytes] }
      : { site: args.site, kind, ip_address: "127.0.0.1", source: null }
    let unchanged = false
    try {
      await rpc(args, session, "site_icon_set", params)
    } catch (error) {
      // Deepwell rejects an update that changes neither the source nor
      // the bytes. That rejection is the already-imported state, so a
      // re-run is a no-op success when the stored state matches the
      // desired one; anything else is a real failure.
      const current = await rpc(args, session, "site_icon_get", { site: args.site, kind })
      unchanged = icon ? current?.sha256_hex === sha256 : current === null
      if (!unchanged) throw error
    }
    results.push(icon
      ? { kind, source: icon.url, mime: icon.mime, bytes: icon.bytes.length, sha256, ...(unchanged ? { unchanged: true } : {}) }
      : { kind, source: null, cleared: true, ...(unchanged ? { unchanged: true } : {}) })
  }
  return results
}

export async function main(argv) {
  console.log(JSON.stringify(await importMirrorSiteIcons(parseArgs(argv))))
  return 0
}

await runCliIfMain(import.meta.url, main)
