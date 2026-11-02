#!/usr/bin/env node


import {readFileSync, writeFileSync} from "node:fs";

import {runCliIfMain} from "../src/cli-entry.mjs";
import {
  buildFixtureTombstoneManifest,
  buildSeedIndex,
  buildSourceInventoryIndex,
  classifyMirrorFileRow,
} from "../src/mirror-fixture-file-audit.mjs";

const ROW_COLUMNS = [
  "site_id",
  "site_slug",
  "page_id",
  "page_slug",
  "page_from_wikidot",
  "file_id",
  "name",
  "file_from_wikidot",
  "file_deleted_at",
  "user_id",
  "comments",
  "size",
  "last_revision_id",
];

const DUMP_QUERY = `SELECT f.site_id, s.slug, f.page_id, p.slug, p.from_wikidot, f.file_id, f.name, f.from_wikidot, COALESCE(f.deleted_at::text, ''), r.user_id, r.comments, r.size, (SELECT max(revision_id) FROM file_revision WHERE file_id = f.file_id) FROM file f JOIN page p ON p.page_id = f.page_id JOIN site s ON s.site_id = f.site_id JOIN file_revision r ON r.revision_id = (SELECT max(revision_id) FROM file_revision WHERE file_id = f.file_id) WHERE p.from_wikidot AND p.deleted_at IS NULL ORDER BY 1, 3, 7`;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) fail(`unexpected argument '${flag}' (see --help)`);
    const key = flag.slice(2);
    if (key === "help" || key === "h") return {help: true};
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`flag '${flag}' needs a value`);
    args[key.replaceAll("-", "_")] = value;
    index += 1;
  }
  return args;
}

function parseRow(line) {
  const fields = line.split("	");
  if (fields.length !== ROW_COLUMNS.length) {
    fail(`expected ${ROW_COLUMNS.length} tab columns, got ${fields.length}: '${line.slice(0, 80)}'`);
  }
  const row = {};
  for (let index = 0; index < ROW_COLUMNS.length; index += 1) {
    row[ROW_COLUMNS[index]] = fields[index];
  }
  row.site_id = Number(row.site_id);
  row.page_id = Number(row.page_id);
  row.page_from_wikidot = row.page_from_wikidot === "t" || row.page_from_wikidot === "true";
  row.file_id = Number(row.file_id);
  row.file_from_wikidot = row.file_from_wikidot === "t" || row.file_from_wikidot === "true";
  row.user_id = Number(row.user_id);
  row.size = Number(row.size);
  row.last_revision_id = Number(row.last_revision_id);
  return row;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.rows || !args.seeder_files) {
    console.log(`usage: audit-mirror-fixture-files.mjs --rows <dump.tsv> --seeder-files <deepwell/seeder/files.json> [--source-inventory <inventory.json>] [--classification-out <path>] [--manifest-out <path>]

<inventory.json> is [{site_slug, page_slug, name}, ...] from corpus
attachment metadata or the recorded Wikidot Files list. A seed match
becomes FIXTURE only on a covered page whose inventory omits the name.
Without it, seed matches stay UNCLASSIFIED_LOCAL and the manifest
stays empty by design. A malformed inventory (not an array, or an entry
missing site_slug, page_slug, or name) aborts the run before any output.

Dump the rows first (SELECT-only):
  psql -At -F'	' -c "${DUMP_QUERY}" > dump.tsv
`);
    return args.help ? 0 : 2;
  }

  const seedIndex = buildSeedIndex(
    JSON.parse(readFileSync(args.seeder_files, "utf8")),
  );
  const sourceInventoryIndex = args.source_inventory
    ? buildSourceInventoryIndex(JSON.parse(readFileSync(args.source_inventory, "utf8")))
    : null;
  const lines = readFileSync(args.rows, "utf8")
    .split("\n")
    .map((line) => line.replace(/\r$/u, ""))
    .filter((line) => line.length > 0);

  const classified = [];
  const verdictCounts = {};
  for (const line of lines) {
    const row = parseRow(line);
    const classification = classifyMirrorFileRow(row, seedIndex, sourceInventoryIndex);
    verdictCounts[classification.verdict] = (verdictCounts[classification.verdict] ?? 0) + 1;
    classified.push({row, classification});
  }

  const manifest = buildFixtureTombstoneManifest(classified);
  const classification = {
    schema: "wikijump.mirror_fixture_file_classification.v1",
    dry_run: true,
    row_count: lines.length,
    verdict_counts: verdictCounts,
    rows: classified.map(({row, classification: verdict}) => ({...row, ...verdict})),
  };

  if (args.classification_out) writeFileSync(args.classification_out, `${JSON.stringify(classification, null, 2)}
`);
  if (args.manifest_out) writeFileSync(args.manifest_out, `${JSON.stringify(manifest, null, 2)}
`);
  console.log(JSON.stringify({rows: lines.length, verdict_counts: verdictCounts, manifest_entries: manifest.entry_count}));
  return 0;
}

await runCliIfMain(import.meta.url, main);
