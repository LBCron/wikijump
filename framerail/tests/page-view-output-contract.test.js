import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8")

const STRUCTS_PATH = "../../deepwell/src/services/view/structs.rs"
const VIEWS_PATH = "../src/lib/server/deepwell/views.ts"
const USER_PATH = "../src/lib/server/deepwell/user.ts"

const block = (source, opening) => {
  const start = source.indexOf(opening)
  assert.notEqual(start, -1, opening)
  const open = source.indexOf("{", start)
  assert.notEqual(open, -1, opening)
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++
    else if (source[index] === "}") {
      depth--
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  assert.fail(`unterminated block: ${opening}`)
}

const unionMembers = (source, opening) => {
  const start = source.indexOf(opening)
  assert.notEqual(start, -1, opening)
  const rest = source.slice(start + opening.length)
  const line = rest.slice(0, rest.indexOf("\n")).replace(/;\s*$/, "")
  return line
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .sort()
}

const rustFields = (body) =>
  [...body.matchAll(/^\s*(?:pub\s+)?([a-z_]+):/gm)].map((match) => match[1]).sort()

const tsFields = (body) =>
  [...body.matchAll(/^\s*([a-z_]+)\??:/gm)].map((match) => match[1]).sort()

const snakeCase = (name) =>
  name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()

const rustVariants = (source, enumName) => {
  const body = block(source, `pub enum ${enumName} {`)
  const variants = {}
  let index = 0
  while (index < body.length) {
    if (!/[A-Z]/.test(body[index])) {
      index++
      continue
    }
    const name = /^[A-Z][A-Za-z0-9]*/.exec(body.slice(index))[0]
    index += name.length
    while (index < body.length && body[index] !== "{" && body[index] !== ",") index++
    if (body[index] === "{") {
      const start = index
      let depth = 0
      while (index < body.length) {
        if (body[index] === "{") depth++
        else if (body[index] === "}") {
          depth--
          if (depth === 0) {
            index++
            break
          }
        }
        index++
      }
      variants[snakeCase(name)] = rustFields(body.slice(start + 1, index - 1))
    } else {
      variants[snakeCase(name)] = []
      index++
    }
  }
  return variants
}

const tsDiscriminant = (body) => {
  const match = /type: "([a-z_]+)"/.exec(body)
  assert.ok(match, body)
  return match[1]
}

const enumMirror = (rustSource, rustEnum, tsSource, interfaces) => {
  const rust = rustVariants(rustSource, rustEnum)
  const byDiscriminant = {}
  for (const interfaceName of interfaces) {
    const body = block(tsSource, `interface ${interfaceName} {`)
    byDiscriminant[tsDiscriminant(body)] = body
  }
  assert.deepEqual(Object.keys(byDiscriminant).sort(), Object.keys(rust).sort())
  return { rust, byDiscriminant }
}

test("Framerail PageView names exactly Deepwell's GetPageViewOutput fields", () => {
  const structs = read(STRUCTS_PATH)
  const views = read(VIEWS_PATH)

  const interfaces = ["PageViewFound", "PageViewMissing", "PageViewPermissions"]
  assert.deepEqual(
    unionMembers(views, "export type PageView ="),
    interfaces.slice().sort()
  )

  const base = tsFields(block(views, "interface PageViewDataBase {"))
  const { rust, byDiscriminant } = enumMirror(
    structs,
    "GetPageViewOutput",
    views,
    interfaces
  )

  for (const [variant, fields] of Object.entries(rust)) {
    const data = block(byDiscriminant[variant], "data: PageViewDataBase & {")
    assert.deepEqual([...new Set([...base, ...tsFields(data)])].sort(), fields, variant)
  }
})

test("Framerail admin view names exactly Deepwell's GetAdminViewOutput fields", () => {
  const structs = read(STRUCTS_PATH)
  const views = read(VIEWS_PATH)

  const interfaces = ["AdminViewSiteFound", "AdminViewAdminPermissions"]
  const { rust, byDiscriminant } = enumMirror(
    structs,
    "GetAdminViewOutput",
    views,
    interfaces
  )

  for (const [variant, fields] of Object.entries(rust)) {
    assert.deepEqual(tsFields(block(byDiscriminant[variant], "data: {")), fields, variant)
  }
})

test("Framerail user view names exactly Deepwell's GetUserViewOutput fields", () => {
  const structs = read(STRUCTS_PATH)
  const user = read(USER_PATH)

  const interfaces = ["UserViewFound", "UserViewMissing"]
  assert.deepEqual(
    unionMembers(user, "export type UserViewResult ="),
    interfaces.slice().sort()
  )

  const { rust, byDiscriminant } = enumMirror(
    structs,
    "GetUserViewOutput",
    user,
    interfaces
  )

  for (const [variant, fields] of Object.entries(rust)) {
    const body = byDiscriminant[variant]
    if (body.includes("data?: never")) {
      assert.deepEqual(fields, [], variant)
    } else {
      assert.deepEqual(tsFields(block(body, "data: {")), fields, variant)
    }
  }
})

test("Framerail article view names exactly Deepwell's article output fields", () => {
  const structs = read(STRUCTS_PATH)
  const views = read(VIEWS_PATH)

  assert.deepEqual(
    tsFields(block(views, "interface Viewer {")),
    rustFields(block(structs, "pub struct Viewer {"))
  )

  const rustArticle = rustFields(
    block(structs, "pub struct GetArticleViewOutput {")
  ).filter((field) => field !== "viewer")
  assert.deepEqual(
    tsFields(block(views, "export type ArticleView = Viewer & {")),
    rustArticle
  )

  assert.deepEqual(
    tsFields(block(views, "interface ArticleViewCacheMetadata {")),
    rustFields(block(structs, "pub struct GetArticleViewCacheMetadataOutput {"))
  )
})

test("Framerail view structs name exactly Deepwell's snapshot, breadcrumb, and template fields", () => {
  const structs = read(STRUCTS_PATH)
  const views = read(VIEWS_PATH)

  for (const name of [
    "WikidotPageSnapshotView",
    "WikidotPageBreadcrumbView",
    "PageTemplateSummary",
    "PromotedSiteView"
  ]) {
    assert.deepEqual(
      tsFields(block(views, `interface ${name} {`)),
      rustFields(block(structs, `pub struct ${name} {`)),
      name
    )
  }
})
