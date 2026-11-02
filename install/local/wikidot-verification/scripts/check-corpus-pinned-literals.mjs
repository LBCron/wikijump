#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {runCliIfMain} from "../src/cli-entry.mjs";
import {
  DEFAULT_MAX_PINNED_CASES,
  MIN_FINDING_LENGTH,
  buildCorpusIndex,
  checkCorpusPinnedLiterals,
} from "../src/corpus-pinned-literals.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const DEFAULT_ROOTS = ["deepwell/src/services/render"];
const DEFAULT_ALLOWLIST =
  "install/local/wikidot-verification/fixtures/corpus-pinned-literals/allowlist.json";

export function usage() {
  return [
    "Usage: check-corpus-pinned-literals.mjs --corpus FILE [--corpus FILE]...",
    "                                        [--allowlist FILE] [--max-cases N]",
    "                                        [--strict] [--json] [PATH...]",
    "",
    "Reports compatibility rules pinned to captured page content. A literal is",
    "reported when it appears verbatim in the captured corpus and appears in no",
    `more than ${DEFAULT_MAX_PINNED_CASES} captured pages: genuine module syntax appears in hundreds,`,
    "so rarity is what marks a fragment lifted from one page.",
    "",
    `Matches of ${MIN_FINDING_LENGTH} characters or more are findings; shorter ones are notices,`,
    "because short markup vocabulary is rare in a ListPages corpus without being",
    "lifted from any page. --strict exits non-zero on findings.",
    "",
    "--corpus takes live reference JSONL, one record per line, as captured by the",
    "campaign. Pass every lane so a literal cannot hide in an unread lane.",
    "",
    `Default roots: ${DEFAULT_ROOTS.join(", ")}`,
    "Rust test modules are skipped; regression tests are supposed to hold corpus source.",
    "",
    "This reads string literals only. A rule can overfit through an exact",
    "conjunction of ordinary tokens without any corpus-derived literal, so a",
    "clean report is not proof that a rule generalises.",
  ].join("\n");
}

export function parseArgs(argv) {
  const args = {
    allowlist: DEFAULT_ALLOWLIST,
    corpus: [],
    maxCases: DEFAULT_MAX_PINNED_CASES,
    strict: false,
    json: false,
    paths: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--") continue;
    if (option === "--help" || option === "-h") return {help: true};
    if (option === "--json") {
      args.json = true;
      continue;
    }
    if (option === "--strict") {
      args.strict = true;
      continue;
    }
    if (option === "--corpus" || option === "--allowlist" || option === "--max-cases") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
      if (option === "--corpus") args.corpus.push(value);
      else if (option === "--allowlist") args.allowlist = value;
      else {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error("--max-cases requires a positive integer");
        }
        args.maxCases = parsed;
      }
      continue;
    }
    if (option.startsWith("--")) throw new Error(`unknown option: ${option}`);
    args.paths.push(option);
  }
  if (args.corpus.length === 0) throw new Error("--corpus is required");
  if (args.paths.length === 0) args.paths = [...DEFAULT_ROOTS];
  return args;
}

export function collectRustFiles(root) {
  const absolute = path.resolve(REPO_ROOT, root);
  if (fs.statSync(absolute).isFile()) return [absolute];
  const found = [];
  for (const entry of fs.readdirSync(absolute, {withFileTypes: true})) {
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "tests") continue;
      found.push(...collectRustFiles(child));
      continue;
    }
    if (!entry.name.endsWith(".rs")) continue;
    if (entry.name === "tests.rs" || entry.name.endsWith("_tests.rs")) continue;
    found.push(child);
  }
  return found;
}

export function readCorpusFile(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function formatFinding(finding) {
  const preview =
    finding.literal.length > 96
      ? `${finding.literal.slice(0, 96)}...`
      : finding.literal;
  return [
    `${finding.file}:${finding.line}  (${finding.operator})`,
    `    literal: ${JSON.stringify(preview.replaceAll("\n", "\\n"))}`,
    `    appears in ${finding.corpus_case_count} captured page(s): ${finding.corpus_case_ids.join(", ")}`,
  ].join("\n");
}

export function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const files = args.paths.flatMap((root) => collectRustFiles(root));
  const sources = files.map((file) => {
    const relative = path.relative(REPO_ROOT, file);
    return {
      path: relative.startsWith("..") ? file : relative,
      source: fs.readFileSync(file, "utf8"),
    };
  });
  const corpus = buildCorpusIndex(
    args.corpus.flatMap((file) => readCorpusFile(path.resolve(REPO_ROOT, file))),
  );
  const allowlist = JSON.parse(
    fs.readFileSync(path.resolve(REPO_ROOT, args.allowlist), "utf8"),
  );
  const report = checkCorpusPinnedLiterals({
    sources,
    corpus,
    allowlist,
    maxCases: args.maxCases,
    hashLiteral: (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex"),
  });

  const exitCode = args.strict && report.status !== "clean" ? 1 : 0;

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return exitCode;
  }

  console.log(
    `scanned ${report.scanned_file_count} Rust files against ${report.corpus_case_count} captured pages`,
  );
  if (report.acknowledged.length > 0) {
    console.log(`${report.acknowledged.length} allowlisted literal(s) present`);
  }
  if (report.findings.length === 0 && report.notices.length === 0) {
    console.log("no corpus-pinned literals found");
    return exitCode;
  }
  if (report.findings.length > 0) {
    console.log(`\n${report.findings.length} corpus-pinned literal(s):\n`);
    for (const finding of report.findings) console.log(`${formatFinding(finding)}\n`);
  }
  if (report.notices.length > 0) {
    console.log(
      `${report.notices.length} short rare literal(s) for review, listed shortest first:`,
    );
    for (const notice of [...report.notices].sort((a, b) => a.literal.length - b.literal.length)) {
      console.log(
        `  ${notice.file}:${notice.line}  ${JSON.stringify(notice.literal)}  in ${notice.corpus_case_count} page(s)`,
      );
    }
    console.log("");
  }
  if (report.findings.length === 0) return exitCode;
  console.log(
    [
      "Each of these reproduces the named pages and nothing else. Replace it with",
      "the rule those pages demonstrate, proven by live observation including",
      "negative controls, or leave the case actionable and record it as",
      "unimplemented. Add an allowlist entry only when the pinned form is",
      "genuinely the whole of Wikidot's behaviour, and cite the live observations",
      "that establish that.",
    ].join("\n"),
  );
  return exitCode;
}

await runCliIfMain(import.meta.url, main, {
  onError: (error) => {
    console.error(error.message);
    return 2;
  },
});
