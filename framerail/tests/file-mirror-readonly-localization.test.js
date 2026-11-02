// @ts-nocheck
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"


const enPath = new URL("../../locales/fluent/wiki-page/en.ftl", import.meta.url)
const jaPath = new URL("../../locales/fluent/wiki-page/ja.ftl", import.meta.url)

test("mirror read-only popup text is localized in English and Japanese", async () => {
  const en = await readFile(enPath, "utf8")
  const ja = await readFile(jaPath, "utf8")

  for (const line of [
    "wiki-page-file-mirror-readonly =",
    ".title = PERMISSION ERROR",
    ".lead-in = Please note:",
    ".message = Files on this imported page are read-only.",
    ".extra-message = Mirror pages show the source inventory. Ask a site administrator to update their files through the Wikidot import."
  ]) {
    assert.ok(en.includes(line), `en.ftl: ${line}`)
  }

  for (const line of [
    "wiki-page-file-mirror-readonly =",
    ".title = PERMISSION ERROR",
    ".lead-in = ご注意ください:",
    ".message = このインポートされたページのファイルは読み取り専用です。",
    ".extra-message = ミラーページにはソースのファイル一覧が表示されます。ファイルの更新は、サイト管理者にWikidotのインポート経由で行うよう依頼してください。"
  ]) {
    assert.ok(ja.includes(line), `ja.ftl: ${line}`)
  }
})

test("mirror read-only keys are requested and typed", async () => {
  const presentation = await readFile(
    new URL("../src/lib/server/load/page/page-presentation.ts", import.meta.url),
    "utf8"
  )
  const types = await readFile(new URL("../src/types/index.ts", import.meta.url), "utf8")

  for (const key of [
    "wiki-page-file-mirror-readonly.title",
    "wiki-page-file-mirror-readonly.lead-in",
    "wiki-page-file-mirror-readonly.message",
    "wiki-page-file-mirror-readonly.extra-message"
  ]) {
    assert.ok(
      presentation.includes(`"${key}": {}`),
      `page-presentation.ts requests ${key}`
    )
    assert.ok(types.includes(`"${key}": string`), `types/index.ts types ${key}`)
  }
})
