import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCorpusIdentityManifest,
  collectReferencedAuthorNames,
  CORPUS_IDENTITY_MANIFEST_SCHEMA,
} from "../src/corpus-identity-manifest.mjs";
import { writePage } from "./support/corpus-import-manifest-fixture.mjs";

function writeIdentityCorpus(root) {
  writePage(root, "en", "scp-1", {
    entityId: "11111111-1111-4111-8111-111111111111",
    meta: {
      fullname: "scp-1",
      title: "SCP-1",
      title_shown: "SCP-1",
      created_by: "SeekGull",
      updated_by: "SeekGull",
      commented_by: "daveyoufool",
    },
  });
  writePage(root, "en", "scp-2", {
    entityId: "22222222-2222-4222-8222-222222222222",
    meta: {
      fullname: "scp-2",
      title: "SCP-2",
      title_shown: "SCP-2",
      created_by: "SeekGull",
      updated_by: "NameCollision",
      commented_by: null,
    },
  });
  writePage(root, "en", "tale-1", {
    entityId: "33333333-3333-4333-8333-333333333333",
    meta: {
      fullname: "tale-1",
      title: "Tale",
      title_shown: "Tale",
      created_by: "NobodyInObservations",
      updated_by: "NameCollision",
      commented_by: null,
    },
  });
}

const OBSERVATIONS = [
  {
    user_id: 101,
    name: "SeekGull",
    slug: "seekgull",
    source_reference: "https://scp-wiki.wikidot.com/forum/t-1/a",
  },
  {
    user_id: 202,
    name: "daveyoufool",
    slug: "daveyoufool",
    source_reference: "https://scp-wiki.wikidot.com/forum/t-1/b",
  },
  {
    user_id: 303,
    name: "NameCollision",
    slug: "name-collision-a",
    source_reference: "https://scp-wiki.wikidot.com/forum/t-2/a",
  },
  {
    user_id: 404,
    name: "NameCollision",
    slug: "name-collision-b",
    source_reference: "https://scp-wiki.wikidot.com/forum/t-3/a",
  },
  {
    user_id: 505,
    name: "Unreferenced Actor",
    slug: "unreferenced-actor",
    source_reference: "https://scp-wiki.wikidot.com/forum/t-4/a",
  },
];

test("collectReferencedAuthorNames groups pages and roles per name", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-identity-"));
  writeIdentityCorpus(root);
  const referenced = collectReferencedAuthorNames({
    branchPagesRoot: path.join(root, "en", "pages"),
  });
  assert.deepEqual([...referenced.keys()], [
    "NameCollision",
    "NobodyInObservations",
    "SeekGull",
    "daveyoufool",
  ]);
  assert.deepEqual(referenced.get("SeekGull"), {
    pages: ["scp-1", "scp-2"],
    roles: ["created_by", "updated_by"],
  });
  assert.deepEqual(referenced.get("daveyoufool"), {
    pages: ["scp-1"],
    roles: ["commented_by"],
  });
});

test("buildCorpusIdentityManifest joins, gaps, and never merges", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-identity-"));
  writeIdentityCorpus(root);
  const manifest = buildCorpusIdentityManifest({
    corpusRoot: root,
    branch: "en",
    observations: OBSERVATIONS,
    profiles: [{ user_id: 101 }],
  });
  assert.equal(manifest.schema, CORPUS_IDENTITY_MANIFEST_SCHEMA);
  assert.equal(manifest.branch, "en");

  assert.deepEqual(
    manifest.matched.map((row) => [row.name, row.user_id]),
    [
      ["SeekGull", 101],
      ["daveyoufool", 202],
    ],
  );
  const seekgull = manifest.matched.find((row) => row.name === "SeekGull");
  assert.equal(seekgull.source_reference, "https://scp-wiki.wikidot.com/forum/t-1/a");
  assert.deepEqual(seekgull.pages, ["scp-1", "scp-2"]);

  assert.deepEqual(
    manifest.unmatched_names.map((row) => row.name),
    ["NobodyInObservations"],
  );

  assert.equal(manifest.ambiguous.length, 1);
  assert.deepEqual(manifest.ambiguous[0].user_ids, [303, 404]);

  assert.deepEqual(
    manifest.unreferenced_observations.map((row) => row.user_id),
    [303, 404, 505],
  );

  assert.deepEqual(manifest.ids_without_profiles, [202, 303, 404, 505]);

  assert.deepEqual(manifest.summary, {
    referenced_names: 4,
    matched_names: 2,
    unmatched_names: 1,
    ambiguous_names: 1,
    observed_ids_without_profiles: 4,
  });
});

test("buildCorpusIdentityManifest rejects malformed observations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-identity-"));
  writeIdentityCorpus(root);
  assert.throws(
    () =>
      buildCorpusIdentityManifest({
        corpusRoot: root,
        branch: "en",
        observations: [
          {
            user_id: -7,
            name: "Bad",
            slug: "bad",
            source_reference: "https://example.invalid/",
          },
        ],
      }),
    /positive integer/,
  );
  assert.throws(
    () =>
      buildCorpusIdentityManifest({
        corpusRoot: root,
        branch: "en",
        observations: [
          { user_id: 101, name: "", slug: "bad", source_reference: "https://example.invalid/" },
        ],
      }),
    /non-empty string/,
  );
});
