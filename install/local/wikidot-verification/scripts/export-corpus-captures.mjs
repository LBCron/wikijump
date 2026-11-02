#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {runCliIfMain} from "../src/cli-entry.mjs";
import {
  exportCorpusCaptures,
  listStoredCorpusPages,
  rawCapturePayloadProblem,
  readStoredCorpusCapture,
} from "../src/corpus-capture-export.mjs";

export function usage() {
  return "Usage: export-corpus-captures.mjs --export-root <dir> --site <site> [--branch en] [--run-id <id>] " +
    "[--identity-corpus-root <dir>] (--captures <file> | --from-corpus <root> | --raw-dir <dir>) " +
    "[--fullname <page>...] [--slug-file <file>] [--all-pages] [--dry-run]";
}

export function parseArgs(argv) {
  const args = {
    exportRoot: null,
    branch: "en",
    site: null,
    runId: null,
    identityCorpusRoot: null,
    capturesPath: null,
    fromCorpus: null,
    rawDir: null,
    fullnames: [],
    slugFile: null,
    allPages: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "--export-root") args.exportRoot = next();
    else if (arg === "--branch") args.branch = next();
    else if (arg === "--site") args.site = next();
    else if (arg === "--run-id") args.runId = next();
    else if (arg === "--identity-corpus-root") args.identityCorpusRoot = next();
    else if (arg === "--captures") args.capturesPath = next();
    else if (arg === "--from-corpus") args.fromCorpus = next();
    else if (arg === "--raw-dir") args.rawDir = next();
    else if (arg === "--fullname") args.fullnames.push(next());
    else if (arg === "--slug-file") args.slugFile = next();
    else if (arg === "--all-pages") args.allPages = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") return {help: true};
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.exportRoot) throw new Error("--export-root is required");
  if (!args.site) throw new Error("--site is required");
  const modes = [args.capturesPath, args.fromCorpus, args.rawDir].filter((v) => v !== null);
  if (modes.length !== 1) {
    throw new Error("exactly one of --captures, --from-corpus, --raw-dir is required");
  }
  if (args.slugFile !== null) {
    const listed = fs.readFileSync(args.slugFile, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
    args.fullnames.push(...listed);
  }
  if (args.fromCorpus !== null && !args.allPages && args.fullnames.length === 0) {
    throw new Error("--from-corpus requires --fullname, --slug-file, or --all-pages");
  }
  args.runId ??= `wikijump-export-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  return args;
}

function readCapturesFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`${filePath}: captures JSON is not an array`);
    return parsed;
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${filePath}: capture line ${index + 1} is invalid JSON: ${error.message}`);
      }
    });
}

function readRawDirectory(rawDir) {
  const captures = [];
  const problems = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        let payload;
        try {
          payload = JSON.parse(fs.readFileSync(entryPath, "utf8"));
        } catch (error) {
          problems.push({fullname: null, reason: `${entryPath}: invalid JSON: ${error.message}`});
          continue;
        }
        const problem = rawCapturePayloadProblem(payload);
        if (problem !== null) {
          problems.push({
            fullname: typeof payload?.fullname === "string" ? payload.fullname : null,
            reason: `${entryPath}: ${problem}`,
          });
          continue;
        }
        captures.push({
          fullname: payload.fullname,
          transport: "wikidot.py-fallback",
          received_at: fs.statSync(entryPath).mtime.toISOString(),
          payload,
          meta_payload: null,
          source_file: entryPath,
        });
      }
    }
  };
  visit(rawDir);
  return {captures, problems};
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  let captures = [];
  const preProblems = [];
  if (args.capturesPath !== null) {
    captures = readCapturesFile(args.capturesPath);
  } else if (args.rawDir !== null) {
    const raw = readRawDirectory(args.rawDir);
    captures = raw.captures;
    preProblems.push(...raw.problems);
  } else {
    const fullnames = args.allPages
      ? listStoredCorpusPages(args.fromCorpus, args.branch)
      : [...new Set(args.fullnames)];
    for (const fullname of fullnames) {
      const stored = readStoredCorpusCapture(args.fromCorpus, args.branch, fullname);
      if (stored.ok) captures.push(stored.capture);
      else preProblems.push({fullname: stored.fullname, reason: stored.reason});
    }
  }

  if (args.dryRun) {
    const exportable = [];
    for (const capture of captures) {
      const problem = rawCapturePayloadProblem(capture?.payload);
      if (problem === null) exportable.push(capture.payload.fullname);
      else preProblems.push({fullname: capture?.payload?.fullname ?? null, reason: problem});
    }
    console.log(JSON.stringify({
      dry_run: true,
      run_id: args.runId,
      branch_root: path.join(args.exportRoot, args.branch),
      exportable,
      not_exportable: preProblems,
    }, null, 2));
    return exportable.length > 0 ? 0 : 3;
  }

  if (captures.length === 0) {
    console.log(JSON.stringify({
      run_id: args.runId,
      branch_root: path.join(args.exportRoot, args.branch),
      exported: [],
      not_exportable: preProblems,
      response_count: 0,
    }, null, 2));
    return preProblems.length > 0 ? 3 : 2;
  }

  const summary = exportCorpusCaptures({
    exportRoot: args.exportRoot,
    branch: args.branch,
    site: args.site,
    runId: args.runId,
    captures,
    identityCorpusRoot: args.identityCorpusRoot,
  });
  summary.not_exportable = [...preProblems, ...summary.not_exportable];
  console.log(JSON.stringify(summary, null, 2));
  return summary.exported.length > 0 ? 0 : 3;
}

await runCliIfMain(import.meta.url, main, {
  onError: (error) => {
    console.error(error?.stack ?? error?.message ?? String(error));
    return 2;
  },
});
