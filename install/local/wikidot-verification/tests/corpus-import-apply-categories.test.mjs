import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPrecreateDbShellCategoriesSql,
  dbShellCategorySlug,
} from "../scripts/apply-corpus-import-manifest.mjs";

const SCP_WIKI = { siteSlug: "scp-wiki", runBranches: ["05command", "en", "ko"] };

function row(overrides = {}) {
  return {
    source_site: "scpko",
    source_branch: "ko",
    fullname: "theme:fogwalker",
    attachments: [],
    ...overrides,
  };
}

test("dbShellCategorySlug derives the category from the storage slug", () => {
  assert.equal(dbShellCategorySlug(SCP_WIKI, row()), "_foreign:scpko:theme");
  assert.equal(
    dbShellCategorySlug(SCP_WIKI, row({ fullname: "component:image-block" })),
    "_foreign:scpko:component",
  );
  assert.equal(
    dbShellCategorySlug(SCP_WIKI, row({ source_site: "scp-wiki", source_branch: "en" })),
    "theme",
    "the holding site's own rows keep their fullname category",
  );
  assert.equal(
    dbShellCategorySlug(SCP_WIKI, row({ source_site: "en", source_branch: "en" })),
    "theme",
    "a row from an imported branch is own, so its category is the fullname category",
  );
  assert.equal(
    dbShellCategorySlug(SCP_WIKI, row({ fullname: "scp-173" })),
    "_foreign:scpko",
    "a category-less foreign fullname lands in the _foreign:<source> category, matching Deepwell's split at the last colon",
  );
});

test("category precreate inserts the storage categories for foreign rows", () => {
  const args = { createMode: "db", siteId: 6000006, holding: SCP_WIKI };
  const foreignOnly = buildPrecreateDbShellCategoriesSql(args, [
    row(),
    row({ fullname: "component:image-block" }),
    row({ fullname: "info:start" }),
  ]);
  assert.ok(foreignOnly.includes("(6000006, '_foreign:scpko:theme')"));
  assert.ok(foreignOnly.includes("(6000006, '_foreign:scpko:component')"));
  assert.ok(foreignOnly.includes("(6000006, '_foreign:scpko:info')"));
  assert.ok(
    !foreignOnly.includes("(6000006, 'theme')"),
    "a foreign row must not precreate or claim the holding site's own theme category",
  );

  const mixed = buildPrecreateDbShellCategoriesSql(args, [
    row(),
    row({ source_site: "scp-wiki", source_branch: "en" }),
  ]);
  assert.ok(mixed.includes("(6000006, '_foreign:scpko:theme')"));
  assert.ok(mixed.includes("(6000006, 'theme')"), "own rows still precreate their fullname category");
});

test("category precreate stays inert outside db create mode", () => {
  assert.equal(
    buildPrecreateDbShellCategoriesSql({ createMode: "rpc", siteId: 6000006, holding: SCP_WIKI }, [row()]),
    null,
  );
});
