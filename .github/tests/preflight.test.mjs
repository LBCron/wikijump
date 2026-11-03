import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const headOid = "1".repeat(40)
const remoteOid = "2".repeat(40)

const writeExecutable = (file, source) => {
  writeFileSync(file, source)
  chmodSync(file, 0o755)
}

function createHarness(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "wikijump-preflight-"))
  const bin = path.join(directory, "bin")
  const commandLog = path.join(directory, "commands.log")
  const pathLog = path.join(directory, "paths.log")
  mkdirSync(bin)
  mkdirSync(path.join(directory, "evidence-store"), { recursive: true })
  writeFileSync(commandLog, "")
  writeFileSync(pathLog, "")
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  writeExecutable(path.join(bin, "git"), `#!/usr/bin/env bash
set -euo pipefail

if [[ "\${1:-}" == -C ]]; then shift 2; fi

emit_scope() {
  case "$1" in
    all)
      printf '%s\\0' \
        deepwell/src/lib.rs \
        wws/src/lib.rs \
        framerail/src/lib.ts \
        locales/validator/src/main.rs
      ;;
    deepwell) printf '%s\\0' deepwell/src/lib.rs ;;
    theme_lab) printf '%s\\0' install/local/theme-lab/src/example.mjs ;;
    deepwell_space) printf '%s\\0' 'deepwell/src/file with space.rs' ;;
    none) ;;
    docs) printf '%s\\0' docs/development.md ;;
    verification) printf '%s\\0' install/local/wikidot-verification/src/example.mjs ;;
    *) echo "unexpected fake scope: $1" >&2; exit 4 ;;
  esac
}

case "$1" in
  rev-parse)
    if [[ "\${2:-}" == --show-toplevel ]]; then
      printf '%s\\n' "$PREFLIGHT_FAKE_ROOT"
    elif [[ "\${2:-}" == --path-format=absolute && "\${3:-}" == --git-path ]]; then
      printf '%s\\n' "$PREFLIGHT_FAKE_EXCLUDE"
    elif [[ "\${2:-}" == HEAD ]]; then
      printf '%s\\n' "$PREFLIGHT_HEAD_OID"
    else
      exit 0
    fi
    ;;
  merge-base)
    printf '%s\\n' "$3"
    ;;
  diff)
    if [[ "$PREFLIGHT_GIT_DIFF_FAIL" == true ]]; then
      exit 5
    fi
    if [[ "$#" -eq 6 ]]; then
      if [[ "$5" == "$PREFLIGHT_REMOTE_OID" ]]; then
        emit_scope "$PREFLIGHT_REMOTE_SCOPE"
      else
        emit_scope "$PREFLIGHT_FALLBACK_SCOPE"
      fi
    fi
    ;;
  *)
    echo "unexpected fake git invocation: $*" >&2
    exit 4
    ;;
esac
`)

  for (const command of ["cargo", "pnpm", "python3"]) {
    writeExecutable(path.join(bin, command), `#!/usr/bin/env bash
set -euo pipefail
# One write per line, so parallel groups cannot interleave entries.
line="${command}$(printf ' %s' "$@")"
if [[ -n "\${PREFLIGHT_DELAY_MATCH:-}" && "$*" == *"$PREFLIGHT_DELAY_MATCH"* ]]; then sleep 1; fi
printf '%s\\n' "$line" >> "$PREFLIGHT_COMMAND_LOG"
if [[ -n "\${PREFLIGHT_FAIL_MATCH:-}" && "$*" == *"$PREFLIGHT_FAIL_MATCH"* ]]; then exit 1; fi
`)
  }

  writeExecutable(path.join(bin, "node"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == .github/scripts/classify-changes.mjs ]]; then
  if [[ "$PREFLIGHT_CLASSIFIER_FAIL" == true ]]; then
    cat >/dev/null
    exit 6
  fi
  tee "$PREFLIGHT_PATH_LOG" | "$PREFLIGHT_REAL_NODE" "$@"
else
  line="node$(printf ' %s' "$@")"
  if [[ -n "\${PREFLIGHT_DELAY_MATCH:-}" && "$*" == *"$PREFLIGHT_DELAY_MATCH"* ]]; then sleep 1; fi
  printf '%s\n' "$line" >> "$PREFLIGHT_COMMAND_LOG"
  if [[ -n "\${PREFLIGHT_FAIL_MATCH:-}" && "$*" == *"$PREFLIGHT_FAIL_MATCH"* ]]; then exit 1; fi
fi
`)

  const environment = (overrides = {}) => ({
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PREFLIGHT_CLASSIFIER_FAIL: "false",
    // Serial, so the recorded command order is deterministic.
    PREFLIGHT_JOBS: "1",
    PREFLIGHT_COMMAND_LOG: commandLog,
    PREFLIGHT_FAKE_EXCLUDE: path.join(directory, "info-exclude"),
    PREFLIGHT_FAKE_ROOT: root,
    PREFLIGHT_FALLBACK_SCOPE: "all",
    PREFLIGHT_GIT_DIFF_FAIL: "false",
    PREFLIGHT_HEAD_OID: headOid,
    PREFLIGHT_PATH_LOG: pathLog,
    PREFLIGHT_REAL_NODE: process.execPath,
    PREFLIGHT_REMOTE_OID: remoteOid,
    PREFLIGHT_REMOTE_SCOPE: "all",
    ...overrides
  })

  return {
    commands() {
      return readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean)
    },
    receivedPaths() {
      return readFileSync(pathLog, "utf8").split("\0").filter(Boolean)
    },
    runPreflight(args = [], overrides = {}) {
      return spawnSync("bash", ["scripts/preflight.sh", ...args], {
        cwd: root,
        encoding: "utf8",
        env: environment(overrides)
      })
    }
  }
}

test("checkpoint preflight avoids compiled checks for every selected group", (t) => {
  const harness = createHarness(t)
  const result = harness.runPreflight(["--base", remoteOid])

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(harness.commands(), [
    "cargo fmt --manifest-path deepwell/Cargo.toml --check",
    "cargo fmt --manifest-path wws/Cargo.toml --check",
    "pnpm --dir framerail lint",
    "pnpm --dir framerail test:unit",
    "cargo fmt --manifest-path locales/validator/Cargo.toml --all -- --check"
  ])
})

test("preflight preserves changed path boundaries", (t) => {
  const harness = createHarness(t)
  const result = harness.runPreflight(["--base", remoteOid], {
    PREFLIGHT_REMOTE_SCOPE: "deepwell_space"
  })

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(harness.receivedPaths(), ["deepwell/src/file with space.rs"])
  assert.deepEqual(harness.commands(), [
    "cargo fmt --manifest-path deepwell/Cargo.toml --check"
  ])
})

test("preflight fails closed when changed path collection fails", (t) => {
  const harness = createHarness(t)
  const result = harness.runPreflight(["--base", remoteOid], {
    PREFLIGHT_GIT_DIFF_FAIL: "true"
  })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /failed to collect changed paths/)
  assert.deepEqual(harness.commands(), [])
})

test("preflight fails closed when change classification fails", (t) => {
  const harness = createHarness(t)
  const result = harness.runPreflight(["--base", remoteOid], {
    PREFLIGHT_CLASSIFIER_FAIL: "true"
  })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /failed to classify changed paths/)
  assert.deepEqual(harness.commands(), [])
})

test("final preflight is the single explicit full-check barrier", (t) => {
  const harness = createHarness(t)
  const result = harness.runPreflight(["--base", remoteOid, "--final"])

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(harness.commands(), [
    "cargo fmt --manifest-path deepwell/Cargo.toml --check",
    "cargo machete deepwell",
    "cargo clippy --manifest-path deepwell/Cargo.toml --tests --no-deps -- -D warnings",
    "node install/local/wikidot-verification/scripts/run-deepwell-integration-validation.mjs",
    "cargo fmt --manifest-path wws/Cargo.toml --check",
    "cargo machete wws",
    "cargo clippy --manifest-path wws/Cargo.toml --tests --no-deps -- -D warnings",
    "cargo test --manifest-path wws/Cargo.toml --locked --all-features -- --nocapture --test-threads 1",
    "node --test wws/tests/resize-iframe.test.mjs",
    "pnpm --dir framerail lint",
    "pnpm --dir framerail test:unit",
    "pnpm --dir framerail build",
    "cargo fmt --manifest-path locales/validator/Cargo.toml --all -- --check",
    "cargo clippy --manifest-path locales/validator/Cargo.toml --locked --tests --no-deps -- -A unused -D warnings",
    "cargo run --manifest-path locales/validator/Cargo.toml --locked"
  ])

  const help = harness.runPreflight(["--help"])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /default checkpoint does not compile Cargo targets/)
  assert.match(help.stdout, /--final/)
  assert.doesNotMatch(help.stdout, /--full/)
  assert.doesNotMatch(help.stdout, /set -uo pipefail/)
  assert.equal(harness.runPreflight(["--full"]).status, 2)

  const source = readFileSync(path.join(root, "scripts/preflight.sh"), "utf8")
  assert.match(
    source,
    /run_test "deepwell full tests" env WIKIJUMP_DEEPWELL_TEST_SHARDS="\$\{WIKIJUMP_DEEPWELL_TEST_SHARDS:-12\}" node[\s\\]+install\/local\/wikidot-verification\/scripts\/run-deepwell-integration-validation\.mjs/u
  )
})

test("final preflight runs groups side by side with the same checks, ordered logs, and every failure", (t) => {
  const serial = createHarness(t)
  const serialResult = serial.runPreflight(["--base", remoteOid, "--final"])
  assert.equal(serialResult.status, 0, serialResult.stderr)

  const parallel = createHarness(t)
  const result = parallel.runPreflight(["--base", remoteOid, "--final"], {
    PREFLIGHT_JOBS: "0",
    PREFLIGHT_FAIL_MATCH: "clippy --manifest-path wws/Cargo.toml",
    // Logged late, so a Deepwell shard started beside it would log first.
    PREFLIGHT_DELAY_MATCH: "--dir framerail test:unit"
  })
  assert.equal(result.status, 1, result.stdout)
  assert.deepEqual([...parallel.commands()].sort(), [...serial.commands()].sort())
  const sections = (output) => [...output.matchAll(/^=== (.+)$/gmu)].map((match) => match[1])
  assert.deepEqual(sections(result.stdout), sections(serialResult.stdout))
  assert.match(result.stdout, /^--- wws clippy: FAILED \(\d+s\)$/mu)
  assert.match(result.stdout, /^--- deepwell clippy: ok \(\d+s\)$/mu)
  assert.match(result.stdout, /^preflight: FAILED: wws clippy$/mu)
  assert.match(result.stdout, /^preflight: finished group deepwell$/mu)
  assert.match(result.stdout, /^preflight: finished group deepwell_lint$/mu)

  // Suites with wall-clock deadlines finish before the Deepwell shards start.
  const order = parallel.commands()
  const lastTimed = order.indexOf("pnpm --dir framerail test:unit")
  const firstDeepwell = order.findIndex((command) =>
    command.includes("run-deepwell-integration-validation.mjs"))
  assert.ok(lastTimed >= 0 && firstDeepwell > lastTimed, order.join("\n"))
})

test("verification inputs run only the final verification barrier", async (t) => {
  const checkpointExpected = []
  const finalExpected = [
    "pnpm --dir install/local/wikidot-verification test",
    "python3 -m unittest discover -s install/standing/tests -p test_*.py"
  ]

  for (const scope of ["verification"]) {
    await t.test(scope, (t) => {
      const checkpoint = createHarness(t)
      const checkpointResult = checkpoint.runPreflight(["--base", remoteOid], {
        PREFLIGHT_REMOTE_SCOPE: scope
      })
      assert.equal(checkpointResult.status, 0, checkpointResult.stderr)
      assert.deepEqual(checkpoint.commands(), checkpointExpected)

      const final = createHarness(t)
      const finalResult = final.runPreflight(["--base", remoteOid, "--final"], {
        PREFLIGHT_REMOTE_SCOPE: scope
      })
      assert.equal(finalResult.status, 0, finalResult.stderr)
      assert.deepEqual(final.commands(), finalExpected)
    })
  }
})

test("explicit groups run without a change-set and unknown groups are refused", (t) => {
  const listed = createHarness(t)
  const result = listed.runPreflight(["--base", remoteOid, "--final", "--groups", "theme_lab", "--list"], {
    PREFLIGHT_REMOTE_SCOPE: "none"
  })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /nothing to check/)
  assert.match(result.stdout, /^preflight: groups: .*theme_lab=true/mu)
  const steps = [...result.stdout.matchAll(/^  would run: (.+)$/gmu)].map((match) => match[1])
  assert.ok(steps.includes("Theme Lab tests"), result.stdout)
  assert.ok(steps.includes("Theme Lab Python tests"), result.stdout)

  const unknown = createHarness(t)
  const refused = unknown.runPreflight(["--base", remoteOid, "--final", "--groups", "theme_lba", "--list"], {
    PREFLIGHT_REMOTE_SCOPE: "none"
  })
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /unknown group in --groups: theme_lba/)
  assert.deepEqual(unknown.commands(), [])

  const idle = createHarness(t)
  const quiet = idle.runPreflight(["--base", remoteOid, "--final"], { PREFLIGHT_REMOTE_SCOPE: "none" })
  assert.equal(quiet.status, 0, quiet.stderr)
  assert.match(quiet.stdout, /nothing to check/)
  assert.deepEqual(idle.commands(), [])
})

test("listing without a change-set still prints the group plan (the nightly shape)", (t) => {
  // A scheduled consolidated-validation run has base == head, so the
  // diff is empty by construction; the workflow plan step reads the
  // group universe from the --list output and applies its own (nightly)
  // selection. The listing must therefore print the plan - every group,
  // nothing selected - instead of the "nothing to check" early return.
  const harness = createHarness(t)
  const result = harness.runPreflight(["--base", remoteOid, "--final", "--list"], {
    PREFLIGHT_REMOTE_SCOPE: "none"
  })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /nothing to check/)
  const groupsLine = result.stdout.match(/^preflight: groups: (.*)$/mu)?.[1] ?? ""
  for (const group of ["deepwell", "wws", "framerail", "locales", "workflow", "theme_lab", "verification"]) {
    assert.ok(groupsLine.includes(`${group}=false`), `${group} missing or selected in: ${groupsLine}`)
  }
  assert.doesNotMatch(result.stdout, /would run:/)
  assert.deepEqual(harness.commands(), [])

  // The gate shape is unchanged: without --list the same empty
  // change-set still ends at "nothing to check" and runs nothing.
  const gated = createHarness(t)
  const quiet = gated.runPreflight(["--base", remoteOid, "--final"], { PREFLIGHT_REMOTE_SCOPE: "none" })
  assert.equal(quiet.status, 0, quiet.stderr)
  assert.match(quiet.stdout, /nothing to check/)
  assert.deepEqual(gated.commands(), [])
})
