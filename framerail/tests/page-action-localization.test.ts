import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.ts"

let vite: any
let buildPageTranslateKeys: any
let finalizePreloadData: any
let getPreloadBackendLocales: any

before(async () => {
  vite = await createTestViteServer()
  ;({ buildPageTranslateKeys } = await vite.ssrLoadModule(
    "/src/lib/server/load/page/page-presentation.ts"
  ))
  ;({ finalizePreloadData, getPreloadBackendLocales } = await vite.ssrLoadModule(
    "/src/lib/server/load/preload.ts"
  ))
})

after(async () => {
  if (vite) await vite.close()
})

const pageActionKeys = [
  "edit",
  "vote",
  "history",
  "files",
  "options",
  "layout",
  "parents",
  "delete",
  "wiki-page-view-source",
  "wiki-page-action-append",
  "wiki-page-action-edit-sections",
  "wiki-page-action-edit-meta",
  "wiki-page-action-watchers",
  "wiki-page-action-backlinks",
  "wiki-page-action-lock",
  "wiki-page-action-rename-move",
  "wiki-page-file-history",
  "wiki-page-parent",
  "wiki-page-edit",
  "wiki-page-lock"
]

test("page presentation requests every primary and expanded action label", () => {
  const keys = buildPageTranslateKeys(
    {
      type: "found",
      data: {
        page: { created_at: "2026-10-01T00:00:00.000Z" },
        page_revision: { revision_number: 1 }
      }
    },
    {
      licenseName: "CC BY-SA",
      licenseUrl: "https://example.test/license",
      locales: ["ja"],
      now: 0
    }
  )

  for (const key of pageActionKeys) assert.ok(Object.hasOwn(keys, key), key)
})

test("the registration legal disclosure is localized in English and Japanese", async () => {
  const baseEn = await readFile(
    new URL("../../locales/fluent/base/en.ftl", import.meta.url),
    "utf8"
  )
  const baseJa = await readFile(
    new URL("../../locales/fluent/base/ja.ftl", import.meta.url),
    "utf8"
  )

  // The disclosure sentence is composed from localized fragments around two
  // real links, so every locale that renders the registration form defines
  // all five fragments. Latin-script locales own their separator spaces with
  // Fluent string literals, because a bare trailing space in a message is
  // trimmed by the Fluent parser.
  const englishFragments = {
    "register.legal-notice": 'By creating an account you accept our{ " " }',
    "register.legal-terms": "Terms of Service",
    "register.legal-conjunction": '{ " " }and{ " " }',
    "register.legal-privacy": "Privacy Policy",
    "register.legal-suffix": "."
  }
  const japaneseFragments = {
    "register.legal-notice": "アカウントを作成すると、",
    "register.legal-terms": "利用規約",
    "register.legal-conjunction": "および",
    "register.legal-privacy": "プライバシーポリシー",
    "register.legal-suffix": "に同意したものとみなされます。"
  }
  const attributeLines = (source: string, fragments: Record<string, string>) =>
    Object.entries(fragments).map(
      ([key, value]) => `  .${key.slice("register.".length)} = ${value}`
    )
  for (const line of attributeLines(baseEn, englishFragments)) {
    assert.ok(baseEn.includes(`\n${line}\n`), `en: ${line.trim()}`)
  }
  for (const line of attributeLines(baseJa, japaneseFragments)) {
    assert.ok(baseJa.includes(`\n${line}\n`), `ja: ${line.trim()}`)
  }
})

test("English fallback and Japanese catalogs define the exact page action labels", async () => {
  const baseEn = await readFile(
    new URL("../../locales/fluent/base/en.ftl", import.meta.url),
    "utf8"
  )
  const baseJa = await readFile(
    new URL("../../locales/fluent/base/ja.ftl", import.meta.url),
    "utf8"
  )
  const wikiEn = await readFile(
    new URL("../../locales/fluent/wiki-page/en.ftl", import.meta.url),
    "utf8"
  )
  const wikiJa = await readFile(
    new URL("../../locales/fluent/wiki-page/ja.ftl", import.meta.url),
    "utf8"
  )
  const wikiZhHans = await readFile(
    new URL("../../locales/fluent/wiki-page/zh_Hans.ftl", import.meta.url),
    "utf8"
  )

  const baseLabels: Record<string, string> = {
    delete: "削除",
    edit: "編集",
    files: "ファイル",
    history: "履歴",
    layout: "レイアウト",
    options: "オプション",
    parents: "親ページ",
    vote: "評価"
  }
  const pageLabels = {
    "wiki-page-view-source": "ページソース",
    "wiki-page-action-append": "追加",
    "wiki-page-action-edit-sections": "セクションを編集",
    "wiki-page-action-edit-meta": "メタを編集",
    "wiki-page-action-watchers": "ウォッチャー",
    "wiki-page-action-backlinks": "バックリンク",
    "wiki-page-action-lock": "ページロック",
    "wiki-page-action-rename-move": "リネーム"
  }
  for (const key of Object.keys(baseLabels)) {
    assert.match(baseEn, new RegExp(`^${key} = .+$`, "mu"), `en: ${key}`)
    assert.match(baseJa, new RegExp(`^${key} = ${baseLabels[key]}$`, "mu"), `ja: ${key}`)
  }
  for (const [key, label] of Object.entries(pageLabels)) {
    assert.match(wikiEn, new RegExp(`^${key} = .+$`, "mu"), `en: ${key}`)
    assert.match(wikiJa, new RegExp(`^${key} = ${label}$`, "mu"), `ja: ${key}`)
  }
  // zh-Hans localizes the existing lock pane; its action-button label falls
  // back to English. Do not reintroduce the extra action-lock message that
  // Fluent's parent-catalog validation rejected (#2500).
  assert.match(wikiZhHans, /^wiki-page-lock = 锁定页面$/mu)
  assert.match(wikiZhHans, /^ {2}\.permission-only = 仅权限用户$/mu)
  assert.doesNotMatch(wikiZhHans, /^wiki-page-action-lock\s*=/mu)
  assert.match(wikiZhHans, /^wiki-page-action-rename-move = 移动$/mu)
})

test("non-Japanese page locales retain the English fallback after their preferred locale", () => {
  assert.deepEqual(getPreloadBackendLocales(["ja"]), ["ja", "en"])
  assert.deepEqual(getPreloadBackendLocales(["zh-Hans"]), ["zh-Hans", "en"])
})

const foundResponse = {
  type: "found",
  data: {
    page: { created_at: "2026-10-01T00:00:00.000Z" },
    page_revision: { revision_number: 1 }
  }
}

const foundKeysContext = {
  licenseName: "CC BY-SA",
  licenseUrl: "https://example.test/license",
  locales: ["ja"],
  now: 0
}

const EXCLUDED_PAGE_KEYS = new Set([
  "footer-powered-by",
  "footer-license-unless",
  "terms-conditions",
  "privacy",
  "docs",
  "security",
  "spinny-label.active",
  "spinny-label.error",
  "spinny-label.success",
  "spinny-label.warning",
  "message-loading",
  "field-required",
  "hold-to-show-password"
])
const ownsPageKey = (key: string) =>
  !key.startsWith("footer-") && !EXCLUDED_PAGE_KEYS.has(key)

const catalogFor = (key: string) => (key.startsWith("wiki-page-") ? "wiki-page" : "base")

const parseCatalog = (source: string) => {
  const messages = new Map<string, { value: string; attributes: Set<string> }>()
  let current: { value: string; attributes: Set<string> } | null = null
  for (const line of source.split("\n")) {
    const message = /^([A-Za-z][A-Za-z0-9_-]*) = ?(.*)$/.exec(line)
    if (message) {
      current = { value: message[2], attributes: new Set<string>() }
      messages.set(message[1], current)
      continue
    }
    const attribute = /^ {2}\.([A-Za-z0-9_-]+) =/.exec(line)
    if (attribute && current) current.attributes.add(attribute[1])
  }
  return messages
}

test("English and Japanese catalogs define every requested page key", async () => {
  const keys = Object.keys(
    buildPageTranslateKeys(foundResponse, foundKeysContext)
  ).filter(ownsPageKey)
  assert.ok(keys.length > 100, `expected a full page key set, saw ${keys.length}`)

  const sources: Record<string, ReturnType<typeof parseCatalog>> = {}
  for (const catalog of ["base", "wiki-page"]) {
    for (const locale of ["en", "ja"]) {
      sources[`${catalog}/${locale}`] = parseCatalog(
        await readFile(
          new URL(`../../locales/fluent/${catalog}/${locale}.ftl`, import.meta.url),
          "utf8"
        )
      )
    }
  }

  for (const key of keys) {
    const catalog = catalogFor(key)
    const dot = key.indexOf(".")
    const message = dot < 0 ? key : key.slice(0, dot)
    const attribute = dot < 0 ? null : key.slice(dot + 1)
    for (const locale of ["en", "ja"]) {
      const entry = sources[`${catalog}/${locale}`].get(message)
      assert.ok(entry, `${locale}: missing message ${message} (for ${key})`)
      if (attribute) {
        assert.ok(
          entry.attributes.has(attribute),
          `${locale}: ${message} is missing attribute ${attribute}`
        )
      } else {
        assert.ok(entry.value.length > 0, `${locale}: ${message} has no value`)
      }
    }
  }
})

const preloadResponse = (siteLocale: string, userLocales: string[] | null) => ({
  site: { locale: siteLocale },
  site_settings: {},
  promoted_sites: [],
  site_file_domain: "files.example.test",
  license_name: "CC BY-SA",
  license_url: "https://example.test/license",
  license_kind: "standard",
  license_html: null,
  user_session: userLocales ? { user: { locales: userLocales } } : null
})

test("the site language defines the page interface ahead of browser preferences", () => {
  assert.deepEqual(
    finalizePreloadData(preloadResponse("ja", null), ["en-US", "en"]).locales,
    ["ja", "en", "en-US"]
  )
  assert.deepEqual(finalizePreloadData(preloadResponse("en", null), ["ja"]).locales, [
    "en",
    "ja"
  ])
})

test("Japanese catalog defines the revision banner chrome requested for found pages", async () => {
  const keys = buildPageTranslateKeys(foundResponse, foundKeysContext)
  const bannerKeys = [
    "wiki-page-revision-banner.title",
    "wiki-page-revision-banner.page",
    "wiki-page-revision-banner.close"
  ]
  for (const key of bannerKeys) assert.ok(Object.hasOwn(keys, key), key)

  const wikiJa = await readFile(
    new URL("../../locales/fluent/wiki-page/ja.ftl", import.meta.url),
    "utf8"
  )
  assert.match(wikiJa, /^wiki-page-revision-banner =$/mu)
  assert.match(wikiJa, /^ {2}\.title = 過去のリビジョン$/mu)
  assert.match(wikiJa, /^ {2}\.page = ページ$/mu)
  assert.match(wikiJa, /^ {2}\.close = 閉じる$/mu)
})

test("Japanese catalog defines the unimported watchers notice requested for found pages", async () => {
  const keys = buildPageTranslateKeys(foundResponse, foundKeysContext)
  assert.ok(Object.hasOwn(keys, "wiki-page-watchers-unimported"))

  for (const [file, pattern] of [
    [
      "en",
      /^wiki-page-watchers-unimported = The watcher list for this imported page is unavailable because its subscriptions were not imported\.$/mu
    ],
    [
      "ja",
      /^wiki-page-watchers-unimported = インポートされたページのウォッチャー一覧は、購読情報がインポートされていないため利用できません。$/mu
    ]
  ] as [string, RegExp][]) {
    const source = await readFile(
      new URL(`../../locales/fluent/wiki-page/${file}.ftl`, import.meta.url),
      "utf8"
    )
    assert.match(source, pattern, file)
  }
})

test("explicit user locale preferences outrank the site language", () => {
  assert.deepEqual(finalizePreloadData(preloadResponse("ja", ["ko"]), ["en"]).locales, [
    "ko",
    "ja",
    "en"
  ])
})

test("visible page action text remains the anchor accessible name", async () => {
  const pageView = await readFile(
    new URL("../src/routes/[slug]/[...extra]/PageView.svelte", import.meta.url),
    "utf8"
  )
  const actionKeys = {
    "edit-button": "internationalization?.edit",
    "pagerate-button": "internationalization?.vote",
    "history-button": "internationalization?.history",
    "files-button": "internationalization?.files",
    "more-options-button": "internationalization?.options",
    "edit-append-button": "wiki-page-action-append",
    "edit-sections-button": "wiki-page-action-edit-sections",
    "edit-meta-button": "wiki-page-action-edit-meta",
    "watchers-button": "wiki-page-action-watchers",
    "backlinks-button": "wiki-page-action-backlinks",
    "view-source-button": "wiki-page-view-source",
    "layout-button": "internationalization?.layout",
    "parent-page-button": "internationalization?.parents",
    "lock-page-button": "wiki-page-action-lock",
    "rename-move-button": "wiki-page-action-rename-move",
    "delete-button": "internationalization?.delete"
  }

  for (const [id, labelExpression] of Object.entries(actionKeys)) {
    const literal = pageView.indexOf(`id="${id}"`)
    const start = literal >= 0 ? literal : pageView.indexOf(`: "${id}"}`)
    assert.ok(start >= 0, id)
    const end = pageView.indexOf("</a>", start)
    assert.ok(end >= start, id)
    assert.ok(pageView.slice(start, end).includes(labelExpression), id)
  }
})
