#!/usr/bin/env node


import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { runCliIfMain } from "../src/cli-entry.mjs";
import {
  STANDING_DUMP_QUERY,
  buildRepairManifest,
  decideApply,
  parseRowList,
} from "../src/webp-mime-repair.mjs";

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) fail(`unexpected argument '${flag}' (see --help)`);
    const key = flag.slice(2);
    if (key === "help" || key === "h") return { help: true };
    if (key === "apply" || key === "standing") {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`flag '${flag}' needs a value`);
    args[key.replaceAll("-", "_")] = value;
    index += 1;
  }
  return args;
}

function dumpFromStanding() {
  const output = execFileSync(
    "docker",
    [
      "exec",
      "-u",
      "postgres",
      "wikijump-standing-database-1",
      "psql",
      "-U",
      "wikijump",
      "-d",
      "wikijump",
      "-h",
      "127.0.0.1",
      "-At",
      "-F\t",
      "-c",
      STANDING_DUMP_QUERY,
    ],
    { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
  );
  return output;
}

function refusingRunner() {
  return async () => {
    fail("no database runner is wired in this lane: Standing writes need explicit approval");
  };
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || (!args.rows && !args.standing) || !args.manifest_out || !args.row_list_out) {
    console.log(`usage: webp-mime-repair-dryrun.mjs (--rows <dump.tsv> | --standing) --manifest-out <path> --row-list-out <path> [--apply --approval-sha256 <sha256>]

Default is DRY-RUN (SELECT-only; writes the row list + manifest, applies nothing).
--apply additionally requires --approval-sha256 to equal the manifest sha256
AND WIKIJUMP_REPAIR_APPROVED=1 in the environment, else it exits 2 refusing.
`);
    return args.help ? 0 : 2;
  }

  const dump = args.standing ? dumpFromStanding() : readFileSync(args.rows, "utf8");
  const rows = parseRowList(dump);
  const manifest = buildRepairManifest(rows);
  writeFileSync(args.row_list_out, `${dump.endsWith("\n") ? dump : `${dump}\n`}`);
  writeFileSync(args.manifest_out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    JSON.stringify({
      rows: rows.length,
      counts: manifest.counts,
      row_list_sha256: manifest.row_list_sha256,
      dry_run: !args.apply,
    }),
  );

  if (!args.apply) return 0;
  if (process.env.WIKIJUMP_REPAIR_APPROVED !== "1") {
    console.error("refusing: WIKIJUMP_REPAIR_APPROVED=1 is not set");
    return 2;
  }
  try {
    const result = await decideApply(
      manifest,
      { apply: true, approvalSha256: args.approval_sha256 },
      refusingRunner(),
    );
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.error(error?.message ?? String(error));
    return 2;
  }
}

await runCliIfMain(import.meta.url, main);
