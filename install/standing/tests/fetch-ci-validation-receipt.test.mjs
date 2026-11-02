import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CI_RECEIPT_SCHEMA,
  findRunId,
  landReceipt,
  receiptFileName,
  verifyReceipt,
} from "../scripts/fetch-ci-validation-receipt.mjs";

const HEAD = "a".repeat(40);
const TREE = "b".repeat(40);

const receipt = (overrides = {}) => ({
  schema: CI_RECEIPT_SCHEMA,
  status: "pass",
  wikijump_commit: HEAD,
  wikijump_tree: TREE,
  checks: [{name: "example", status: "ok"}],
  ...overrides,
});

test("verifyReceipt accepts a receipt bound to the requested head and tree", () => {
  assert.equal(verifyReceipt(receipt(), {head: HEAD, tree: TREE}).status, "pass");
});

test("verifyReceipt refuses a receipt for a different head", () => {
  assert.throws(
    () => verifyReceipt(receipt({wikijump_commit: "c".repeat(40)}), {head: HEAD, tree: TREE}),
    /not the requested head/u,
  );
});

test("verifyReceipt refuses a receipt whose tree differs from the head's tree", () => {
  assert.throws(
    () => verifyReceipt(receipt({wikijump_tree: "d".repeat(40)}), {head: HEAD, tree: TREE}),
    /does not match/u,
  );
});

test("verifyReceipt refuses a foreign schema and a short head", () => {
  assert.throws(
    () => verifyReceipt(receipt({schema: "wikijump.other.v1"}), {head: HEAD, tree: TREE}),
    /receipt schema/u,
  );
  assert.throws(() => verifyReceipt(receipt(), {head: "abc123", tree: TREE}), /full commit SHA/u);
});

test("landReceipt writes once, reports an identical re-land, and refuses a conflicting one", async (t) => {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "wikijump-receipt-store-"));
  t.after(() => fs.rm(storeDir, {recursive: true, force: true}));
  const text = JSON.stringify(receipt());

  const first = await landReceipt(text, {storeDir, head: HEAD});
  assert.equal(first.landed, true);
  assert.equal(path.basename(first.path), receiptFileName(HEAD));
  assert.equal(await fs.readFile(first.path, "utf8"), text);

  const second = await landReceipt(text, {storeDir, head: HEAD});
  assert.equal(second.landed, false);

  await assert.rejects(
    () => landReceipt(JSON.stringify(receipt({status: "fail"})), {storeDir, head: HEAD}),
    /refusing to replace/u,
  );
});

test("findRunId picks the newest completed run for the head", async () => {
  const runGh = async (args) => {
    assert.match(args[1], /head_sha=/u);
    return JSON.stringify({
      workflow_runs: [
        {id: 3, status: "in_progress"},
        {id: 2, status: "completed"},
        {id: 1, status: "completed"},
      ],
    });
  };
  assert.equal(await findRunId({repo: "Rokurolize/wikijump", workflow: "consolidated-validation.yml", head: HEAD, runGh}), 2);
});

test("findRunId fails when no completed run exists for the head", async () => {
  const runGh = async () => JSON.stringify({workflow_runs: [{id: 3, status: "queued"}]});
  await assert.rejects(
    () => findRunId({repo: "Rokurolize/wikijump", workflow: "consolidated-validation.yml", head: HEAD, runGh}),
    /no completed/u,
  );
});
