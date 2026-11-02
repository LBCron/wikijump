import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyConsolidatedChecks,
  parsePreflightOutput,
  runConsolidatedValidation,
} from "../scripts/run-consolidated-validation.mjs";
import { validateConsolidatedValidation } from "../src/final-frozen-receipt-contract.mjs";

const W17_MISSING_CAMPAIGN_OUTPUT = [
  "preflight: groups: deepwell=false wws=false framerail=false theme_lab=true verification=false",
  "=== source-bound generated contracts",
  "--- source-bound generated contracts: ok (1s)",
  "=== Theme Lab adaptation authority",
  "--- Theme Lab adaptation authority: ok (1s)",
  "=== Theme Lab authority evidence restore",
  "--- Theme Lab authority evidence restore: ok (1s)",
  "=== Theme Lab current campaign evidence restore",
  "--- Theme Lab current campaign evidence restore: FAILED (1s)",
  "=== Theme Lab current campaign completion",
  "--- Theme Lab current campaign completion: FAILED (1s)",
  "preflight: FAILED: Theme Lab current campaign evidence restore Theme Lab current campaign completion",
];

async function runFixture(t, label, lines, exitCode = 0, imageBuild = false) {
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "theme-lab-inconclusive-"),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  const script = path.join(repo, "scripts/preflight.sh");
  await fs.mkdir(path.dirname(script), { recursive: true });
  await fs.writeFile(
    script,
    `#!/usr/bin/env bash\nprintf '%s\\n' ${lines.map((line) => `'${line.replaceAll("'", "'\\''")}'`).join(" ")}\nexit ${exitCode}\n`,
  );
  for (const source of [
    "scripts/run-test-no-external-network.sh",
    "install/local/wikidot-verification/scripts/run-deepwell-integration-validation.mjs",
  ]) {
    const target = path.join(repo, source);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `# ${label}\n`);
  }
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "--quiet", repo]);
  git("config", "user.email", "local-test@example.invalid");
  git("config", "user.name", "Theme Lab validation fixture");
  git("add", ".");
  git("commit", "-qm", label);
  const output = path.join(temp, "receipt.json");
  const { receipt } = await runConsolidatedValidation({
    repository: repo,
    base: "HEAD",
    output,
    log: path.join(temp, "preflight.log"),
    groups: "theme_lab",
    imageBuild,
    buildImages: async () => ({}),
  });
  assert.deepEqual(JSON.parse(await fs.readFile(output, "utf8")), receipt);
  assert.equal(receipt.wikijump_commit, git("rev-parse", "HEAD"));
  assert.equal(receipt.wikijump_tree, git("rev-parse", "HEAD^{tree}"));
  const standingDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../standing",
  );
  const admitted = execFileSync(
    "python3",
    [
      "-c",
      [
        "import sys",
        "from pathlib import Path",
        "sys.path.insert(0, sys.argv[1])",
        "import promote",
        "print(len(promote.validation_receipts(Path(sys.argv[2]))))",
      ].join("; "),
      standingDir,
      temp,
    ],
    { encoding: "utf8" },
  ).trim();
  assert.equal(admitted, receipt.status === "pass" ? "1" : "0");
  return receipt;
}

test("missing current campaign fails the hard restore and completion checks", async (t) => {
  const receipt = await runFixture(t, "no-current-campaign", W17_MISSING_CAMPAIGN_OUTPUT, 1);
  assert.equal(receipt.status, "fail");
  assert.equal(receipt.preflight.exit, 1);
  assert.deepEqual(
    receipt.checks.map((row) => row.status),
    ["ok", "ok", "ok", "failed", "failed"],
  );
  assert.deepEqual(
    classifyConsolidatedChecks(
      receipt.preflight.exit,
      receipt.groups,
      receipt.checks,
    ),
    {
      passed: false,
      failed: [
        "Theme Lab current campaign evidence restore",
        "Theme Lab current campaign completion",
      ],
      inconclusive: [],
    },
  );
  assert.throws(
    () =>
      validateConsolidatedValidation(receipt, {
        wikijump_commit: receipt.wikijump_commit,
        wikijump_tree: receipt.wikijump_tree,
      }),
    /did not pass: Theme Lab current campaign evidence restore, Theme Lab current campaign completion/u,
  );
});

test("an INCONCLUSIVE check can no longer bypass the barrier", async (t) => {
  const output = W17_MISSING_CAMPAIGN_OUTPUT.map((line) =>
    line.replaceAll(
      "Theme Lab current campaign completion: FAILED",
      "Theme Lab current campaign completion: INCONCLUSIVE",
    ),
  );
  const receipt = await runFixture(t, "inconclusive-completion", output, 1);
  assert.equal(receipt.status, "fail");
  assert.deepEqual(
    classifyConsolidatedChecks(
      receipt.preflight.exit,
      receipt.groups,
      receipt.checks,
    ).failed,
    [
      "Theme Lab current campaign evidence restore",
      "Theme Lab current campaign completion",
    ],
  );
});

test("source/authority failures and nonzero preflight exit never turn into PASS", async (t) => {
  const failedAuthority = W17_MISSING_CAMPAIGN_OUTPUT.map((row) =>
    row.replace(
      "Theme Lab adaptation authority: ok",
      "Theme Lab adaptation authority: FAILED",
    ),
  );
  const receipt = await runFixture(t, "failed-authority", failedAuthority, 1);
  assert.equal(receipt.status, "fail");
  assert.deepEqual(
    classifyConsolidatedChecks(
      receipt.preflight.exit,
      receipt.groups,
      receipt.checks,
    ).failed,
    [
      "Theme Lab adaptation authority",
      "Theme Lab current campaign evidence restore",
      "Theme Lab current campaign completion",
    ],
  );
});

test("an arbitrary INCONCLUSIVE check cannot bypass the barrier", async (t) => {
  const output = W17_MISSING_CAMPAIGN_OUTPUT.map((line) =>
    line
      .replaceAll(
        "Theme Lab current campaign completion",
        "Theme Lab source evidence",
      )
      .replaceAll(
        "Theme Lab source evidence: FAILED",
        "Theme Lab source evidence: INCONCLUSIVE",
      ),
  );
  const receipt = await runFixture(t, "wrong-inconclusive", output, 1);
  assert.equal(receipt.status, "fail");
  assert.deepEqual(
    classifyConsolidatedChecks(
      receipt.preflight.exit,
      receipt.groups,
      receipt.checks,
    ).failed,
    [
      "Theme Lab current campaign evidence restore",
      "Theme Lab source evidence",
    ],
  );
});

test("an absent check or an INCONCLUSIVE-only run cannot claim code validation PASS", () => {
  assert.equal(
    classifyConsolidatedChecks(0, { theme_lab: true }, []).passed,
    false,
  );
  assert.equal(
    classifyConsolidatedChecks(0, { theme_lab: true }, [
      { name: "Theme Lab current campaign completion", status: "inconclusive" },
    ]).passed,
    false,
  );
  assert.equal(
    classifyConsolidatedChecks(0, { theme_lab: false }, [
      { name: "source authority", status: "ok" },
      { name: "Theme Lab current campaign completion", status: "inconclusive" },
    ]).passed,
    false,
  );
});

test("a passing image build alone never passes an absent source preflight", async (t) => {
  const receipt = await runFixture(
    t,
    "empty-preflight",
    ["preflight: groups: theme_lab=true"],
    0,
    true,
  );
  assert.equal(receipt.status, "fail");
  assert.deepEqual(
    receipt.checks.map((row) => row.name),
    ["standing images build"],
  );
});

test("nested child preflight status lines do not contaminate the enclosing check", () => {
  const parsed = parsePreflightOutput(
    [
      "preflight: groups: verification=true theme_lab=false",
      "=== wikidot verification tests",
      "=== Theme Lab adaptation authority",
      "--- Theme Lab adaptation authority: FAILED (1s)",
      "=== Theme Lab current campaign completion",
      "--- Theme Lab current campaign completion: INCONCLUSIVE (1s)",
      "--- wikidot verification tests: ok (63s)",
    ].join("\n"),
  );
  assert.deepEqual(parsed.checks, [
    { name: "wikidot verification tests", status: "ok", duration_seconds: 63 },
  ]);
});

async function dirtyRepository(t, untrackedFiles, nameLength) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "consolidated-dirty-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  execFileSync("git", ["init", "--quiet", repo]);
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("config", "user.email", "local-test@example.invalid");
  git("config", "user.name", "Theme Lab validation fixture");
  await fs.writeFile(path.join(repo, "tracked.txt"), "tracked\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const restored = path.join(repo, "restored");
  await fs.mkdir(restored);
  for (let start = 0; start < untrackedFiles; start += 500) {
    await Promise.all(
      Array.from({ length: Math.min(500, untrackedFiles - start) }, (_, i) =>
        fs.writeFile(
          path.join(restored, `${String(start + i).padStart(nameLength, "0")}.bin`),
          "",
        ),
      ),
    );
  }
  return { repo, temp };
}

const refusal = (repo, temp) =>
  runConsolidatedValidation({
    repository: repo,
    base: "HEAD",
    output: path.join(temp, "receipt.json"),
    log: path.join(temp, "preflight.log"),
    groups: "theme_lab",
    imageBuild: false,
    buildImages: async () => ({}),
  });

test("a tree with tens of thousands of untracked files is refused with the clean-checkout message, not a buffer crash", async (t) => {
  const { repo, temp } = await dirtyRepository(t, 12000, 100);
  const statusBytes = execFileSync(
    "git",
    ["-C", repo, "status", "--porcelain=v1", "--untracked-files=all"],
    { maxBuffer: 64 * 1024 * 1024 },
  ).length;
  assert.ok(statusBytes > 1024 * 1024, `fixture must exceed the default execFile buffer, got ${statusBytes}`);
  await assert.rejects(refusal(repo, temp), (error) => {
    assert.doesNotMatch(error.code ?? "", /MAXBUFFER/u);
    const lines = error.message.split("\n");
    assert.equal(
      lines[0],
      "consolidated validation requires a clean checkout: 12000 changed or untracked paths, first 20",
    );
    assert.equal(lines.length, 21);
    assert.match(lines[1], /^ {2}\?\? restored\/0+0\.bin$/u);
    return true;
  });
});

test("a single modified tracked file is refused with the clean-checkout message and its path", async (t) => {
  const { repo, temp } = await dirtyRepository(t, 0, 4);
  await fs.writeFile(path.join(repo, "tracked.txt"), "changed\n");
  await assert.rejects(
    refusal(repo, temp),
    (error) =>
      error.message ===
      "consolidated validation requires a clean checkout: 1 changed or untracked paths\n   M tracked.txt",
  );
});
