
import { createHash } from "node:crypto";

export const REPAIR_MIME = "image/webp; charset=binary";
export const AFFECTED_MIME = "application/octet-stream";
export const DUMP_COLUMNS = [
  "file_id",
  "site_slug",
  "page_id",
  "page_slug",
  "name",
  "size",
  "last_revision_id",
  "mime",
  "file_created_at",
];

export const STANDING_DUMP_QUERY = `SELECT f.file_id, s.slug, f.page_id, p.slug, f.name, r.size, (SELECT max(revision_id) FROM file_revision WHERE file_id = f.file_id), r.mime, f.created_at FROM file f JOIN page p ON p.page_id = f.page_id JOIN site s ON s.site_id = f.site_id JOIN file_revision r ON r.revision_id = (SELECT max(revision_id) FROM file_revision WHERE file_id = f.file_id) WHERE f.deleted_at IS NULL AND f.name ILIKE '%.webp' AND r.mime = 'application/octet-stream' ORDER BY 1`;

function fail(message) {
  throw new Error(message);
}

export function parseRowList(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split("\t");
    if (fields.length !== DUMP_COLUMNS.length) {
      fail(
        `expected ${DUMP_COLUMNS.length} tab columns, got ${fields.length}: '${line.slice(0, 80)}'`,
      );
    }
    const row = {};
    for (let index = 0; index < DUMP_COLUMNS.length; index += 1) {
      row[DUMP_COLUMNS[index]] = fields[index];
    }
    row.file_id = Number(row.file_id);
    row.page_id = Number(row.page_id);
    row.size = Number(row.size);
    row.last_revision_id = Number(row.last_revision_id);
    if (!Number.isSafeInteger(row.file_id) || !Number.isSafeInteger(row.last_revision_id)) {
      fail(`non-integer id in row: '${line.slice(0, 80)}'`);
    }
    rows.push(row);
  }
  rows.sort((left, right) => left.file_id - right.file_id);
  return rows;
}

export function canonicalRowList(rows) {
  return JSON.stringify(
    rows.map((row) => [
      row.file_id,
      row.site_slug,
      row.page_id,
      row.page_slug,
      row.name,
      row.size,
      row.last_revision_id,
    ]),
  );
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

export function buildRepairManifest(rows, { generatedAt = new Date().toISOString() } = {}) {
  const entries = rows.map((row) => ({
    file_id: row.file_id,
    site_slug: row.site_slug,
    page_id: row.page_id,
    page_slug: row.page_slug,
    name: row.name,
    size: row.size,
    last_revision_id: row.last_revision_id,
    from_mime: row.mime,
    to_mime: REPAIR_MIME,
  }));
  const rowListSha256 = sha256Hex(canonicalRowList(rows));
  const bySite = {};
  for (const row of rows) {
    bySite[row.site_slug] = (bySite[row.site_slug] ?? 0) + 1;
  }
  return {
    schema: "wikijump.webp_mime_repair_manifest.v1",
    dry_run: true,
    generated_at: generatedAt,
    row_count: rows.length,
    counts: { total: rows.length, by_site: bySite },
    row_list_sha256: rowListSha256,
    repair_mime: REPAIR_MIME,
    entries,
  };
}

export function applyStatements(manifest) {
  return (manifest?.entries ?? []).map(
    (entry) =>
      `UPDATE file_revision SET mime = '${REPAIR_MIME}' WHERE revision_id = ${entry.last_revision_id} AND mime = '${AFFECTED_MIME}';`,
  );
}

export async function decideApply(manifest, { apply = false, approvalSha256 = null } = {}, runner = null) {
  if (!apply) {
    fail("refusing: DRY-RUN only (pass --apply with a matching --approval-sha256 to proceed)");
  }
  if (approvalSha256 !== manifest?.row_list_sha256) {
    fail("refusing: --approval-sha256 must equal the manifest row_list_sha256");
  }
  const statements = applyStatements(manifest);
  if (typeof runner !== "function") {
    fail("refusing: no database runner was provided");
  }
  const results = [];
  for (const statement of statements) {
    results.push(await runner(statement));
  }
  return { status: "applied", statement_count: results.length };
}
