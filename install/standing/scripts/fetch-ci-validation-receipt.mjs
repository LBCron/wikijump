#!/usr/bin/env node

// Land a consolidated-validation receipt produced by the GitHub Actions
// workflow (.github/workflows/consolidated-validation.yml) in the local
// validation store, where install/standing/promote.py reads receipts.
//
// The CI receipt is trusted only after it is bound to the exact head the
// coordinator asked for: its schema must be the consolidated-validation
// receipt schema, its wikijump_commit must equal the requested head, and
// its wikijump_tree must equal that head's tree as resolved in a local
// checkout. Anything else is refused and nothing is written. Landing is
// no-replace: an identical receipt already in the store is reported, a
// different one under the same name is an error.
//
// Usage:
//   node install/standing/scripts/fetch-ci-validation-receipt.mjs \
//     --head <full-commit-sha> [--repository <wikijump-checkout>] \
//     [--store <validation-store-dir>] [--repo <owner/name>] \
//     [--workflow <workflow-file>] [--run-id <actions-run-id>]

import {execFile as execFileCallback} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

const execFile = promisify(execFileCallback);

export const CI_RECEIPT_SCHEMA = "wikijump.consolidated_validation_receipt.v2";
export const DEFAULT_REPO = "Rokurolize/wikijump";
export const DEFAULT_WORKFLOW = "consolidated-validation.yml";
const GIT_OBJECT = /^[0-9a-f]{40}$/u;

function fail(message) {
  throw new Error(message);
}

/** The same store promote.py reads (kept in step with validationStore()
 * in run-consolidated-validation.mjs). */
export function validationStore(env = process.env) {
  const stateRoot = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateRoot, "wikijump", "validation");
}

export function receiptFileName(head) {
  return `validation-ci-${head.slice(0, 12)}.json`;
}

/** Bind a parsed receipt to the requested head and its locally resolved
 * tree. Returns the receipt unchanged; throws on any mismatch. */
export function verifyReceipt(receipt, {head, tree}) {
  if (!receipt || typeof receipt !== "object") fail("receipt is not a JSON object");
  if (receipt.schema !== CI_RECEIPT_SCHEMA) {
    fail(`receipt schema is ${JSON.stringify(receipt.schema)}, expected ${CI_RECEIPT_SCHEMA}`);
  }
  if (!GIT_OBJECT.test(head)) fail(`--head is not a full commit SHA: ${head}`);
  if (receipt.wikijump_commit !== head) {
    fail(`receipt is bound to ${receipt.wikijump_commit ?? "<missing>"}, not the requested head ${head}`);
  }
  if (receipt.wikijump_tree !== tree) {
    fail(`receipt tree ${receipt.wikijump_tree ?? "<missing>"} does not match ${head}^{tree} (${tree})`);
  }
  if (typeof receipt.status !== "string" || receipt.status === "") fail("receipt has no status");
  return receipt;
}

/** Write the receipt bytes into the store under its CI name, without
 * replacing an existing file. Returns {path, landed} where landed is
 * false when an identical receipt was already present. */
export async function landReceipt(receiptText, {storeDir, head}) {
  const target = path.join(storeDir, receiptFileName(head));
  await fs.mkdir(storeDir, {recursive: true, mode: 0o700});
  let existing = null;
  try {
    existing = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing !== null) {
    if (existing === receiptText) return {path: target, landed: false};
    fail(`a different receipt is already stored at ${target}; refusing to replace it`);
  }
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, receiptText, {mode: 0o600});
  try {
    // link(2) fails with EEXIST rather than replacing, so a concurrent
    // local validation sealing the same name cannot be overwritten.
    await fs.link(temporary, target);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  return {path: target, landed: true};
}

async function gh(args, {cwd} = {}) {
  const {stdout} = await execFile("gh", args, {encoding: "utf8", cwd, maxBuffer: 64 * 1024 * 1024});
  return stdout;
}

/** The newest completed run of the workflow whose head is the requested
 * commit. Any conclusion qualifies: a failed gate still seals a receipt,
 * and promote.py only ever reads passing ones. */
export async function findRunId({repo, workflow, head, runGh = gh}) {
  const raw = await runGh([
    "api",
    `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${head}&per_page=10`,
  ]);
  const runs = JSON.parse(raw).workflow_runs ?? [];
  const completed = runs.filter((run) => run.status === "completed");
  if (completed.length === 0) {
    fail(`no completed ${workflow} run found for head ${head} in ${repo}`);
  }
  return completed[0].id;
}

async function downloadReceiptText({repo, runId, head, runGh = gh}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wikijump-ci-receipt-"));
  try {
    await runGh(
      ["run", "download", String(runId), "--repo", repo, "--pattern", "consolidated-validation-*", "--dir", dir],
      {},
    );
    const entries = await fs.readdir(dir, {recursive: true});
    const receiptName = entries.find(
      (entry) => path.basename(entry) === receiptFileName(head) || /^validation-ci-[0-9a-f]{12}\.json$/u.test(path.basename(entry)),
    );
    if (!receiptName) fail(`run ${runId} has no consolidated-validation receipt artifact for ${head}`);
    return await fs.readFile(path.join(dir, receiptName), "utf8");
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

async function headTree(repository, head) {
  const {stdout} = await execFile(
    "git",
    ["-C", repository, "rev-parse", `${head}^{tree}`],
    {encoding: "utf8"},
  );
  return stdout.trim();
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !["--head", "--repository", "--store", "--repo", "--workflow", "--run-id"].includes(flag) ||
      !value ||
      value.startsWith("--")
    ) {
      fail(`invalid option: ${flag ?? "<missing>"}`);
    }
    args[flag.slice(2)] = value;
  }
  if (!args.head) fail("--head is required");
  return args;
}

export async function fetchCiValidationReceipt({
  head,
  repository,
  storeDir = validationStore(),
  repo = DEFAULT_REPO,
  workflow = DEFAULT_WORKFLOW,
  runId = null,
  runGh = gh,
}) {
  const id = runId ?? (await findRunId({repo, workflow, head, runGh}));
  const receiptText = await downloadReceiptText({repo, runId: id, head, runGh});
  const receipt = JSON.parse(receiptText);
  const tree = await headTree(repository, head);
  verifyReceipt(receipt, {head, tree});
  const {path: landedPath, landed} = await landReceipt(receiptText, {storeDir, head});
  return {runId: id, receipt, path: landedPath, landed};
}

async function main(argv) {
  const args = parseArgs(argv);
  const repository = args.repository
    ? path.resolve(args.repository)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const result = await fetchCiValidationReceipt({
    head: args.head,
    repository,
    storeDir: args.store ? path.resolve(args.store) : validationStore(),
    repo: args.repo ?? DEFAULT_REPO,
    workflow: args.workflow ?? DEFAULT_WORKFLOW,
    runId: args["run-id"] ? Number(args["run-id"]) : null,
  });
  console.log(JSON.stringify({
    schema: "wikijump.fetch_ci_validation_receipt_cli_result.v1",
    status: result.receipt.status,
    run_id: result.runId,
    wikijump_commit: result.receipt.wikijump_commit,
    path: result.path,
    landed: result.landed,
  }));
  return 0;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(JSON.stringify({
      schema: "wikijump.fetch_ci_validation_receipt_cli_result.v1",
      status: "error",
      error: error?.message ?? String(error),
    }));
    process.exitCode = 1;
  });
}
