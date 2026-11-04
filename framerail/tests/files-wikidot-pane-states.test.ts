import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.ts"

import { wikidotFileSize } from "../src/lib/wikidot-file-contract.ts"

const escapeRegExp = (value: any) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

const root = fileURLToPath(new URL("..", import.meta.url))

let previousWorkingDirectory: any
let vite: any
let render: any
let SvelteMap: any
let fileListComponent: any
let fileInfoModalComponent: any

const fileEntry = (fileId: any, name: any, mime: any, size: number) => [
  fileId,
  {
    file_id: fileId,
    file_created_at: "2026-04-21T06:01:00Z",
    file_updated_at: null,
    file_deleted_at: null,
    page_id: 7000005,
    revision_id: 9000000 + fileId,
    revision_type: "regular",
    revision_created_at: "2026-04-21T06:01:00Z",
    revision_number: 0,
    revision_user_id: 123,
    name,
    data: null,
    mime,
    size,
    s3_hash: "abc",
    revision_comments: `Uploaded file "${name}"`,
    hidden_fields: []
  }
]

const listProps = (fileMap: any, internationalization: any = {}) => ({
  data: {
    internationalization,
    page: { slug: "scp-9506", page_id: 7000005 },
    site: { site_id: 6000005 },
    site_file_domain: "files.wikijump.test"
  },
  fileMap,
  fileListLoading: false,
  fileListError: null,
  fileListLoaded: true,
  requestedDeletedFiles: false,
  activeFileAction: null,
  fileEditId: 0,
  wikidot: true,
  getFileList: async () => {},
  deleteFile: async () => {},
  openFileHistory: () => {}
})

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  vite = await createTestViteServer()

  ;({ render } = await vite.ssrLoadModule("svelte/server"))
  ;({ SvelteMap } = await vite.ssrLoadModule("svelte/reactivity"))
  ;({ default: fileListComponent } = await vite.ssrLoadModule(
    "/src/routes/[slug]/[...extra]/FileList.svelte"
  ))
  ;({ default: fileInfoModalComponent } = await vite.ssrLoadModule(
    "/src/routes/[slug]/[...extra]/WikidotFileInfoModal.svelte"
  ))
})

after(async () => {
  if (vite) await vite.close()
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

test("empty wikidot list keeps the frozen Files heading, message, and upload", () => {
  const body = render(fileListComponent, {
    props: listProps(new SvelteMap())
  }).body

  assert.match(body, /<h1[^>]*>Files<\/h1>/u)
  assert.match(body, /No files for this page\./u)
  assert.match(body, /id="show-upload-button"/u)
  assert.match(body, /Upload a file from your computer/u)
})

test("empty wikidot list honors a provided no-files message", () => {
  const body = render(fileListComponent, {
    props: listProps(new SvelteMap(), {
      "wiki-page-file-no-files": "Provided empty text."
    })
  }).body

  assert.match(body, /Provided empty text\./u)
  assert.doesNotMatch(body, /No files for this page\./u)
})

test("large wikidot list renders every row with no pagination controls", () => {
  const entries = []
  let bytes = 0
  for (let index = 0; index < 250; index += 1) {
    const name = `file-${String(index).padStart(3, "0")}.png`
    entries.push(fileEntry(1000 + index, name, "image/png", 204126))
    bytes += 204126
  }
  const body = render(fileListComponent, {
    props: listProps(new SvelteMap(entries))
  }).body

  const rows = body.match(/<tr id="file-row-/gu) ?? []
  assert.equal(rows.length, 250)
  assert.match(body, /Total files:\s*250/u)
  assert.match(
    body,
    new RegExp(`Total size:\\s*${escapeRegExp(wikidotFileSize(bytes))}`, "u")
  )
  assert.doesNotMatch(body, /paginat/iu)
  assert.match(body, /file-000\.png/u)
  assert.match(body, /file-249\.png/u)
})

test("info modal renders the frozen static fields", () => {
  const [, file] = fileEntry(1, "AFTER_FOG.png", "image/png", 204126)
  const body = render(fileInfoModalComponent, {
    props: {
      file,
      siteId: 6000005,
      pageId: 7000005,
      fileUrl: "//files.wikijump.test/-/file/scp-9506/AFTER_FOG.png",
      internationalization: {},
      onClose: () => {}
    }
  }).body

  assert.match(body, /id="odialog-shader"/u)
  assert.match(body, /id="owindow-1"/u)
  assert.match(body, />File Information</u)
  assert.match(body, /File name:/u)
  assert.match(body, /AFTER_FOG\.png/u)
  assert.match(body, /Full file URL:/u)
  assert.match(
    body,
    /href="\/\/files\.wikijump\.test\/-\/file\/scp-9506\/AFTER_FOG\.png"/u
  )
  assert.match(body, /File size:/u)
  assert.match(body, /199\.34 kB \(204126 Bytes\)/u)
  assert.match(body, /MIME type:/u)
  assert.match(body, /image\/png/u)
  assert.match(body, /Content type:/u)
  assert.match(body, /PNG image data/u)
  assert.match(body, /value="Close"/u)
})
