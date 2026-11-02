import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import net from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {prepareShardSeedCapture} from "../src/deepwell-integration-stack.mjs";
import {
  SEED_CAPTURE_FORMAT,
  SEED_CAPTURE_MANIFEST,
  SeedCaptureRestoreError,
  computeSeedCaptureKey,
  parseReply,
  readValkeyKeys,
  respPipeline,
  restoreSeedCapture,
  verifySeedCapture,
  withSeedCaptureFallback,
} from "../src/deepwell-seed-capture.mjs";

async function fakeRepository() {
  const root = await mkdtemp(join(tmpdir(), "seed-capture-root-"));
  for (const [path, content] of Object.entries({
    "deepwell/migrations/001_init.sql": "create table a ();",
    "deepwell/migrations/002_more.sql": "create table b ();",
    "deepwell/seeder/users.json": "[]",
    "deepwell/seeder/pages/home.ftml": "hello",
    "locales/en/main.ftl": "greeting = hi",
    "install/local/deepwell/config.toml": "[domain]\nmain = \"x\"\n",
    "binary": "deepwell-binary-v1",
  })) {
    await mkdir(join(root, path, ".."), {recursive: true});
    await writeFile(join(root, path), content);
  }
  return root;
}

const baseInputs = (root) => ({
  root,
  binaryPath: join(root, "binary"),
  imageIds: {database: "sha256:db", cache: "sha256:cache", files: "sha256:files"},
  staticEnv: {S3_FILES_BUCKET: "deepwell-files"},
  seedArguments: ["--seed", "deepwell/seeder"],
});

test("the capture key changes with every input that determines the seeded state", async () => {
  const root = await fakeRepository();
  try {
    const {key: original} = await computeSeedCaptureKey(baseInputs(root));
    assert.equal((await computeSeedCaptureKey(baseInputs(root))).key, original, "the key is stable for unchanged inputs");

    const mutations = {
      "a changed migration": () => writeFile(join(root, "deepwell/migrations/002_more.sql"), "create table b (x int);"),
      "an added migration": () => writeFile(join(root, "deepwell/migrations/003_new.sql"), "select 1;"),
      "a changed seed file": () => writeFile(join(root, "deepwell/seeder/pages/home.ftml"), "goodbye"),
      "an added seed file": () => writeFile(join(root, "deepwell/seeder/pages/new.ftml"), "new"),
      "a changed locale": () => writeFile(join(root, "locales/en/main.ftl"), "greeting = hello"),
      "a changed config": () => writeFile(join(root, "install/local/deepwell/config.toml"), "[domain]\nmain = \"y\"\n"),
      "a changed binary": () => writeFile(join(root, "binary"), "deepwell-binary-v2"),
    };
    const seen = new Set([original]);
    for (const [name, mutate] of Object.entries(mutations)) {
      await mutate();
      const {key} = await computeSeedCaptureKey(baseInputs(root));
      assert.ok(!seen.has(key), `${name} must change the key`);
      seen.add(key);
    }

    const variants = {
      "another database image": {...baseInputs(root), imageIds: {...baseInputs(root).imageIds, database: "sha256:db2"}},
      "other static settings": {...baseInputs(root), staticEnv: {S3_FILES_BUCKET: "other"}},
      "other seed arguments": {...baseInputs(root), seedArguments: ["--seed", "elsewhere"]},
    };
    for (const [name, inputs] of Object.entries(variants)) {
      const {key} = await computeSeedCaptureKey(inputs);
      assert.ok(!seen.has(key), `${name} must change the key`);
      seen.add(key);
    }
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

async function writeCapture(directory, key, files = {"postgres.dump": "pg-bytes", "minio.tar": "minio-bytes", "valkey.json": "[]"}) {
  await mkdir(directory, {recursive: true});
  const artifacts = {};
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), content);
    artifacts[name] = {bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex")};
  }
  await writeFile(join(directory, SEED_CAPTURE_MANIFEST), JSON.stringify({
    format: SEED_CAPTURE_FORMAT, key, artifacts,
    expect: {tableRowCounts: {}, minioListing: [], valkeyKeyCount: 0},
  }));
}

test("a capture is accepted only when its key, sizes, and checksums all match", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seed-capture-verify-"));
  try {
    await writeCapture(directory, "k1");
    await verifySeedCapture(directory, "k1");

    await assert.rejects(verifySeedCapture(directory, "k2"), /written for key k1, expected k2/u);

    const dump = join(directory, "postgres.dump");
    await writeFile(dump, "pg-bytez");
    await assert.rejects(verifySeedCapture(directory, "k1"), /fails its checksum/u, "a flipped byte of equal length");
    await writeFile(dump, "pg-by");
    await assert.rejects(verifySeedCapture(directory, "k1"), /has 5 bytes, expected 8/u, "a truncated file");
    await rm(dump);
    await assert.rejects(verifySeedCapture(directory, "k1"), /postgres\.dump is missing/u);

    await writeCapture(directory, "k1");
    await writeFile(join(directory, SEED_CAPTURE_MANIFEST), "{not json");
    await assert.rejects(verifySeedCapture(directory, "k1"), /manifest unreadable/u);
    await rm(join(directory, SEED_CAPTURE_MANIFEST));
    await assert.rejects(verifySeedCapture(directory, "k1"), /manifest unreadable/u, "an unfinished capture has no manifest");

    await writeCapture(directory, "k1");
    const manifest = JSON.parse(await readFile(join(directory, SEED_CAPTURE_MANIFEST), "utf8"));
    await writeFile(join(directory, SEED_CAPTURE_MANIFEST), JSON.stringify({...manifest, format: SEED_CAPTURE_FORMAT + 1}));
    await assert.rejects(verifySeedCapture(directory, "k1"), /format/u);
    await writeFile(join(directory, SEED_CAPTURE_MANIFEST), JSON.stringify({...manifest, artifacts: {}}));
    await assert.rejects(verifySeedCapture(directory, "k1"), /lists no artifacts/u);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test("restoring a damaged capture fails before touching any container", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seed-capture-restore-"));
  try {
    await writeCapture(directory, "k1");
    await writeFile(join(directory, "postgres.dump"), "tampered");
    const calls = [];
    await assert.rejects(
      restoreSeedCapture({
        run: async (...call) => { calls.push(call); return {stdout: ""}; },
        containers: {database: "db", cache: "cache", files: "files"},
        ports: {database: 1, cache: 2, files: 3},
        buckets: ["a", "b"],
        directory,
        expectedKey: "k1",
      }),
      (error) => error instanceof SeedCaptureRestoreError && /checksum|bytes/u.test(error.message),
    );
    assert.deepEqual(calls, [], "no docker command ran against an unverified capture");
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test("a failed restore falls back to a fresh stack once, a failed body never does", async () => {
  const logs = [];
  const log = (message) => logs.push(message);

  const attempts = [];
  const result = await withSeedCaptureFallback(async (capture) => {
    attempts.push(capture);
    if (capture) throw new SeedCaptureRestoreError("row counts differ");
    return "ran on a seeded stack";
  }, "/captures/k1", {log});
  assert.equal(result, "ran on a seeded stack");
  assert.deepEqual(attempts, ["/captures/k1", null]);
  assert.match(logs.join("\n"), /restore FAILED, seeding this stack the slow way.*row counts differ/u);

  const bodyAttempts = [];
  await assert.rejects(
    withSeedCaptureFallback(async (capture, enteredBody) => {
      bodyAttempts.push(capture);
      enteredBody();
      throw new SeedCaptureRestoreError("raised from inside the test body");
    }, "/captures/k1", {log}),
    /inside the test body/u,
  );
  assert.deepEqual(bodyAttempts, ["/captures/k1"], "a failure after the body started is not retried");

  const otherAttempts = [];
  await assert.rejects(
    withSeedCaptureFallback(async (capture) => { otherAttempts.push(capture); throw new Error("docker is down"); }, "/captures/k1", {log}),
    /docker is down/u,
  );
  assert.deepEqual(otherAttempts, ["/captures/k1"], "only restore failures trigger the fallback");

  const plain = [];
  await withSeedCaptureFallback(async (capture) => { plain.push(capture); }, null, {log});
  assert.deepEqual(plain, [null], "without a capture the stack seeds exactly as before");
});

test("shard capture preparation names, disables, builds, or degrades loudly", async () => {
  const logs = [];
  const log = (message) => logs.push(message);
  const ensureCalls = [];
  const ensure = async (options) => { ensureCalls.push(options); return {directory: join(options.captureRoot, "key"), key: "key"}; };

  const named = await prepareShardSeedCapture({WIKIJUMP_DEEPWELL_SEED_CAPTURE: "/some/capture"}, {ensure, log});
  assert.equal(named.directory, "/some/capture");
  assert.equal(ensureCalls.length, 0);

  const off = await prepareShardSeedCapture({WIKIJUMP_DEEPWELL_SEED_CAPTURE: "off"}, {ensure, log});
  assert.equal(off.directory, null);
  assert.equal(ensureCalls.length, 0);

  const persistent = await prepareShardSeedCapture({WIKIJUMP_DEEPWELL_SEED_CAPTURE_ROOT: "/kept"}, {ensure, log});
  assert.equal(persistent.directory, "/kept/key");
  assert.equal(ensureCalls.at(-1).captureRoot, "/kept");

  const temporary = await prepareShardSeedCapture({}, {ensure, log});
  const temporaryRoot = ensureCalls.at(-1).captureRoot;
  await writeFile(join(temporaryRoot, "marker"), "x");
  await temporary.dispose();
  await assert.rejects(readFile(join(temporaryRoot, "marker")), /ENOENT/u, "a private capture root is removed after the run");

  const failed = await prepareShardSeedCapture({}, {
    ensure: async (options) => { ensureCalls.push(options); throw new Error("seeder exploded"); },
    log,
  });
  assert.equal(failed.directory, null);
  assert.match(logs.join("\n"), /could not be prepared; every shard will seed its own stack: seeder exploded/u);
  await assert.rejects(readFile(join(ensureCalls.at(-1).captureRoot, "marker")), /ENOENT/u, "the failed attempt's root is removed too");
});

test("RESP replies parse across arrays, binary bulks, nulls, and partial input", () => {
  const binary = Buffer.from([0, 255, 13, 10, 1]);
  const reply = Buffer.concat([
    Buffer.from("*4\r\n:42\r\n$-1\r\n+OK\r\n$5\r\n"), binary, Buffer.from("\r\n"),
  ]);
  const parsed = parseReply(reply);
  assert.equal(parsed.next, reply.length);
  assert.equal(parsed.value[0], 42);
  assert.equal(parsed.value[1], null);
  assert.equal(parsed.value[2], "OK");
  assert.ok(Buffer.compare(parsed.value[3], binary) === 0);
  assert.equal(parseReply(reply.subarray(0, reply.length - 3)), null, "incomplete input waits for more bytes");
  assert.ok(parseReply(Buffer.from("-ERR nope\r\n")).value instanceof Error);
});

async function fakeValkey(store) {
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const header = pending.indexOf("\r\n");
        if (header === -1) return;
        const count = Number(pending.toString("utf8", 1, header));
        let cursor = header + 2;
        const args = [];
        for (let index = 0; index < count; index += 1) {
          const lengthEnd = pending.indexOf("\r\n", cursor);
          if (lengthEnd === -1) return;
          const length = Number(pending.toString("utf8", cursor + 1, lengthEnd));
          if (pending.length < lengthEnd + 2 + length + 2) return;
          args.push(pending.subarray(lengthEnd + 2, lengthEnd + 2 + length));
          cursor = lengthEnd + 2 + length + 2;
        }
        pending = pending.subarray(cursor);
        const bulk = (value) => Buffer.concat([Buffer.from(`$${value.length}\r\n`), value, Buffer.from("\r\n")]);
        const [command, key] = [args[0].toString(), args[1]];
        if (command === "SCAN") {
          const keys = [...store.keys()].map((name) => bulk(Buffer.from(name)));
          socket.write(Buffer.concat([Buffer.from(`*2\r\n$1\r\n0\r\n*${keys.length}\r\n`), ...keys]));
        } else if (command === "PEXPIRETIME") {
          socket.write(`:${store.get(key.toString()).expireAt}\r\n`);
        } else if (command === "DUMP") {
          socket.write(bulk(store.get(key.toString()).dump));
        } else {
          socket.write("-ERR unknown\r\n");
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {port: server.address().port, close: () => new Promise((resolve) => server.close(resolve))};
}

test("Valkey keys are read with their absolute expiry and binary DUMP payloads", async () => {
  const dump = Buffer.from([0, 1, 2, 255, 13, 10]);
  const server = await fakeValkey(new Map([
    ["permission:site:1:version", {expireAt: -1, dump}],
    ["listpages:cache", {expireAt: 1_800_000_000_000, dump: Buffer.from("x")}],
  ]));
  try {
    const keys = await readValkeyKeys(server.port);
    assert.equal(keys.length, 2);
    const persistent = keys.find(({key}) => Buffer.from(key, "base64").toString() === "permission:site:1:version");
    assert.equal(persistent.expireAtMs, -1);
    assert.ok(Buffer.compare(Buffer.from(persistent.dump, "base64"), dump) === 0);
    assert.equal(keys.find(({key}) => Buffer.from(key, "base64").toString() === "listpages:cache").expireAtMs, 1_800_000_000_000);
    const [pong] = await respPipeline(server.port, [["BOGUS", "x"]]);
    assert.ok(pong instanceof Error);
  } finally {
    await server.close();
  }
});
