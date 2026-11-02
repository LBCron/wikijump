import assert from "node:assert/strict";
import test from "node:test";

import {
  applyStatements,
  buildRepairManifest,
  decideApply,
  parseRowList,
  sha256Hex,
} from "../src/webp-mime-repair.mjs";

const DUMP = [
  "22\tscp-wiki\t3000000021\tscp-002\tphoto.webp\t5871\t27\tapplication/octet-stream\t2026-07-05 17:20:55.267495+00",
  "23\tscp-wiki\t3000000021\tscp-002\timage.webp\t182048\t28\tapplication/octet-stream\t2026-07-05 17:20:55.267495+00",
].join("\n");

test("parses the standing dump and sorts by file id", () => {
  const rows = parseRowList(`${DUMP}\n`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].file_id, 22);
  assert.equal(rows[1].last_revision_id, 28);
  assert.equal(rows[1].size, 182048);
  assert.equal(rows[0].mime, "application/octet-stream");
});

test("rejects truncated dumps loudly instead of shrinking the list", () => {
  assert.throws(() => parseRowList("22\tscp-wiki\t3000000021\n"), /tab columns/);
  assert.throws(() => parseRowList("abc\tscp-wiki\t1\tscp-002\tn.webp\t1\t2\tapplication/octet-stream\t3\n"), /non-integer/);
  assert.deepEqual(parseRowList(""), []);
});

test("manifest carries counts and a stable row-list sha256", () => {
  const first = buildRepairManifest(parseRowList(DUMP));
  assert.equal(first.row_count, 2);
  assert.deepEqual(first.counts, { total: 2, by_site: { "scp-wiki": 2 } });
  assert.equal(first.dry_run, true);
  assert.match(first.row_list_sha256, /^[0-9a-f]{64}$/);
  assert.equal(first.entries[0].to_mime, "image/webp; charset=binary");
  const lines = DUMP.split("\n").reverse().join("\n");
  assert.equal(buildRepairManifest(parseRowList(lines)).row_list_sha256, first.row_list_sha256);
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("apply statements re-assert the affected MIME per row", () => {
  const manifest = buildRepairManifest(parseRowList(DUMP));
  const statements = applyStatements(manifest);
  assert.equal(statements.length, 2);
  assert.ok(
    statements[0].includes("revision_id = 27") &&
      statements[0].includes("mime = 'application/octet-stream'"),
  );
});

test("apply refuses without the flag, the token, or a runner", async () => {
  const manifest = buildRepairManifest(parseRowList(DUMP));
  await assert.rejects(decideApply(manifest, { apply: false }), /DRY-RUN only/);
  await assert.rejects(
    decideApply(manifest, { apply: true, approvalSha256: "wrong" }),
    /approval-sha256/,
  );
  await assert.rejects(
    decideApply(manifest, { apply: true, approvalSha256: manifest.row_list_sha256 }),
    /no database runner/,
  );
});

test("apply with a matching token runs the guarded statements", async () => {
  const manifest = buildRepairManifest(parseRowList(DUMP));
  const seen = [];
  const result = await decideApply(
    manifest,
    { apply: true, approvalSha256: manifest.row_list_sha256 },
    async (statement) => {
      seen.push(statement);
      return "UPDATE 1";
    },
  );
  assert.deepEqual(result, { status: "applied", statement_count: 2 });
  assert.equal(seen.length, 2);
});
