#!/usr/bin/env node


import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runCliIfMain } from "../src/cli-entry.mjs";
import { CORPUS_SITE_PREFERRED_BRANCHES } from "../src/corpus-include-closure.mjs";
import {
  buildCrossSiteDependencyManifest,
  summarizeCrossSiteCoverage,
} from "../src/corpus-import-manifest.mjs";

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = {
    target_branch: "en",
    target_site: "scp-wiki",
    branches: null,
    preferred_branches: null,
    roots: null,
    attribution: null,
    out_dir: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) fail(`unexpected argument '${flag}' (see --help)`);
    const key = flag.slice(2);
    if (key === "help" || key === "h") return { help: true };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`flag '${flag}' needs a value`);
    args[key.replaceAll("-", "_")] = value;
    index += 1;
  }
  return args;
}

function listPageBranches(corpusRoot) {
  return fs
    .readdirSync(corpusRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return fs.statSync(path.join(corpusRoot, name, "pages")).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.corpus_root || !args.out_dir || (!args.roots && !args.attribution)) {
    console.log(`usage: dry-run-cross-site-include-repair.mjs --corpus-root <dir> --out-dir <dir> (--roots <slugs.txt> | --attribution <attribution.json>) [--target-branch en] [--target-site scp-wiki] [--branches a,b,c] [--preferred-branches <json|{}>]
Defaults: all page-bearing corpus branches; preferredBranches = built-in CORPUS_SITE_PREFERRED_BRANCHES (pass '{}' for the legacy no-preference run).`);
    return args.help ? 0 : 2;
  }
  const startedAt = Date.now();
  const branches = args.branches
    ? args.branches.split(",").map((branch) => branch.trim()).filter(Boolean)
    : listPageBranches(args.corpus_root);
  const preferredBranches =
    args.preferred_branches === null || args.preferred_branches === undefined
      ? CORPUS_SITE_PREFERRED_BRANCHES
      : JSON.parse(args.preferred_branches);
  const affectedSlugs = args.roots
    ? fs.readFileSync(args.roots, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
    : Object.keys(JSON.parse(fs.readFileSync(args.attribution, "utf8")));

  const verdicts = {};
  const attribution = {};
  let rootErrors = 0;
  for (const slug of affectedSlugs) {
    let manifest;
    try {
      manifest = buildCrossSiteDependencyManifest({
        corpusRoot: args.corpus_root,
        targetBranch: args.target_branch,
        targetSite: args.target_site,
        roots: [slug],
        branches,
        includeClosure: { preferredBranches },
      });
    } catch (error) {
      rootErrors += 1;
      verdicts[slug] = { fixed: false, gaps: [], truncated: [] };
      attribution[slug] = { rows: [], gaps: -1, truncated: [], error: String(error?.message ?? error) };
      continue;
    }
    const fixed = manifest.gaps.length === 0 && manifest.summary.truncated.length === 0;
    verdicts[slug] = { fixed, gaps: [], truncated: [...manifest.summary.truncated] };
    attribution[slug] = {
      rows: manifest.rows.map((row) => `${row.source_branch}:${row.fullname}`),
      gaps: manifest.gaps.length,
      truncated: [...manifest.summary.truncated],
    };
  }

  const aggregate = buildCrossSiteDependencyManifest({
    corpusRoot: args.corpus_root,
    targetBranch: args.target_branch,
    targetSite: args.target_site,
    roots: affectedSlugs.filter((slug) => verdicts[slug] && !attribution[slug].error),
    branches,
    includeClosure: { preferredBranches },
  });
  const summary = summarizeCrossSiteCoverage({
    affectedSlugs,
    verdicts,
    manifest: aggregate,
  });
  const fixedRoots = affectedSlugs.filter((slug) => verdicts[slug]?.fixed).sort();
  const fixedRootsSha256 = sha256Hex(`${JSON.stringify(fixedRoots)}\n`);
  const coverage = {
    ...summary,
    fixed_roots: fixedRoots,
    fixed_roots_sha256: fixedRootsSha256,
    root_errors: rootErrors,
    elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
  };

  fs.mkdirSync(args.out_dir, { recursive: true });
  fs.writeFileSync(
    path.join(args.out_dir, "cross-site-manifest.jsonl"),
    `${aggregate.rows.map((row) => `${JSON.stringify(row)}\n`).join("")}`,
  );
  fs.writeFileSync(
    path.join(args.out_dir, "cross-site-gaps.json"),
    `${JSON.stringify(aggregate.gaps, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(args.out_dir, "cross-site-attribution.json"),
    `${JSON.stringify(attribution, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(args.out_dir, "coverage-summary.json"),
    `${JSON.stringify(coverage, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(args.out_dir, "fixed-roots.json"),
    `${JSON.stringify(fixedRoots, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      affected: affectedSlugs.length,
      fixed: fixedRoots.length,
      fixed_roots_sha256: fixedRootsSha256,
      root_errors: rootErrors,
      out_dir: args.out_dir,
    }),
  );
  return 0;
}

await runCliIfMain(import.meta.url, main);
