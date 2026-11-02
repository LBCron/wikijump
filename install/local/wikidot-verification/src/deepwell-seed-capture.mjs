import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {createReadStream, createWriteStream} from "node:fs";
import {readdir, readFile, readlink, stat, writeFile} from "node:fs/promises";
import net from "node:net";
import {join, relative} from "node:path";
import {pipeline} from "node:stream/promises";


export const SEED_CAPTURE_FORMAT = 1;
export const SEED_CAPTURE_MANIFEST = "manifest.json";

const POSTGRES_DUMP = "postgres.dump";
const MINIO_ARCHIVE = "minio.tar";
const VALKEY_KEYS = "valkey.json";
const CONTAINER_DUMP_PATH = "/tmp/seed-capture.dump";
const CONTAINER_EXPORT_DIR = "/tmp/seed-export";
const POSTGRES_CLIENT_ARGS = ["-h", "127.0.0.1", "-U", "wikijump", "-d", "wikijump"];

export class SeedCaptureRestoreError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SeedCaptureRestoreError";
  }
}

function restoreFail(message, cause) {
  throw new SeedCaptureRestoreError(message, cause === undefined ? undefined : {cause});
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function treeEntries(root, directory, entries) {
  for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(directory, entry.name);
    const name = relative(root, path);
    if (entry.isDirectory()) {
      entries.push(`${name}\0dir`);
      await treeEntries(root, path, entries);
    } else if (entry.isSymbolicLink()) {
      entries.push(`${name}\0link\0${await readlink(path)}`);
    } else {
      entries.push(`${name}\0file\0${await sha256File(path)}`);
    }
  }
}

export async function treeDigest(directory) {
  const entries = [];
  await treeEntries(directory, directory, entries);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

export async function computeSeedCaptureKey({root, binaryPath, imageIds, staticEnv, seedArguments}) {
  const inputs = {
    format: SEED_CAPTURE_FORMAT,
    migrations: await treeDigest(join(root, "deepwell/migrations")),
    seeder: await treeDigest(join(root, "deepwell/seeder")),
    locales: await treeDigest(join(root, "locales")),
    config: await sha256File(join(root, "install/local/deepwell/config.toml")),
    binary: await sha256File(binaryPath),
    images: imageIds,
    staticEnv,
    seedArguments,
  };
  const key = createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
  return {key, inputs};
}

export async function verifySeedCapture(directory, expectedKey) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(directory, SEED_CAPTURE_MANIFEST), "utf8"));
  } catch (error) {
    throw new Error(`seed capture manifest unreadable in ${directory}: ${error.message}`, {cause: error});
  }
  if (manifest?.format !== SEED_CAPTURE_FORMAT) {
    throw new Error(`seed capture format ${manifest?.format} is not ${SEED_CAPTURE_FORMAT}`);
  }
  if (manifest.key !== expectedKey) {
    throw new Error(`seed capture was written for key ${manifest.key}, expected ${expectedKey}`);
  }
  const artifacts = Object.entries(manifest.artifacts ?? {});
  if (artifacts.length === 0) throw new Error("seed capture manifest lists no artifacts");
  for (const [name, {bytes, sha256}] of artifacts) {
    const path = join(directory, name);
    let size;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      throw new Error(`seed capture artifact ${name} is missing: ${error.message}`, {cause: error});
    }
    if (size !== bytes) throw new Error(`seed capture artifact ${name} has ${size} bytes, expected ${bytes}`);
    const actual = await sha256File(path);
    if (actual !== sha256) throw new Error(`seed capture artifact ${name} fails its checksum`);
  }
  return manifest;
}

function dockerStreamToFile(args, file) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {stdio: ["ignore", "pipe", "pipe"]});
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const written = pipeline(child.stdout, createWriteStream(file));
    child.on("error", reject);
    child.on("exit", (code) => {
      written.then(
        () => (code === 0 ? resolve() : reject(new Error(`docker ${args[0]} failed with status ${code}: ${stderr.trim()}`))),
        reject,
      );
    });
  });
}

function dockerStreamFromFile(args, file) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {stdio: ["pipe", "ignore", "pipe"]});
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const read = pipeline(createReadStream(file), child.stdin);
    child.on("error", reject);
    child.on("exit", (code) => {
      read.then(
        () => (code === 0 ? resolve() : reject(new Error(`docker ${args[0]} failed with status ${code}: ${stderr.trim()}`))),
        reject,
      );
    });
  });
}

function encodeCommand(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const argument of args) {
    const value = Buffer.isBuffer(argument) ? argument : Buffer.from(String(argument));
    parts.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

export function parseReply(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd === -1) return null;
  const type = String.fromCharCode(buffer[offset]);
  const line = buffer.toString("utf8", offset + 1, lineEnd);
  const next = lineEnd + 2;
  switch (type) {
    case "+": return {value: line, next};
    case "-": return {value: new Error(line), next};
    case ":": return {value: Number(line), next};
    case "$": {
      const length = Number(line);
      if (length === -1) return {value: null, next};
      if (buffer.length < next + length + 2) return null;
      return {value: Buffer.from(buffer.subarray(next, next + length)), next: next + length + 2};
    }
    case "*": {
      const count = Number(line);
      if (count === -1) return {value: null, next};
      const items = [];
      let cursor = next;
      for (let index = 0; index < count; index += 1) {
        const item = parseReply(buffer, cursor);
        if (!item) return null;
        items.push(item.value);
        cursor = item.next;
      }
      return {value: items, next: cursor};
    }
    default:
      throw new Error(`unexpected RESP reply type ${JSON.stringify(type)}`);
  }
}

export function respPipeline(port, commands, {host = "127.0.0.1"} = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({host, port});
    let pending = Buffer.alloc(0);
    const replies = [];
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(replies);
    };
    socket.on("error", finish);
    socket.on("close", () => finish(new Error("Valkey connection closed before every reply arrived")));
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const reply = parseReply(pending);
        if (!reply) break;
        replies.push(reply.value);
        pending = pending.subarray(reply.next);
      }
      if (replies.length === commands.length) finish();
    });
    socket.on("connect", () => socket.write(Buffer.concat(commands.map(encodeCommand))));
    if (commands.length === 0) finish();
  });
}

async function respSingle(port, ...command) {
  const [reply] = await respPipeline(port, [command]);
  if (reply instanceof Error) throw reply;
  return reply;
}

async function scanAllKeys(port) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await respSingle(port, "SCAN", cursor, "COUNT", "1000");
    cursor = next.toString();
    keys.push(...batch);
  } while (cursor !== "0");
  return keys.sort(Buffer.compare);
}

export async function readValkeyKeys(port) {
  const keys = await scanAllKeys(port);
  const replies = await respPipeline(port, keys.flatMap((key) => [["PEXPIRETIME", key], ["DUMP", key]]));
  return keys.map((key, index) => {
    const expireAt = replies[2 * index];
    const dump = replies[2 * index + 1];
    if (expireAt instanceof Error || dump instanceof Error || dump === null) {
      throw new Error(`cannot read Valkey key ${JSON.stringify(key.toString("utf8"))}`);
    }
    return {key: key.toString("base64"), expireAtMs: expireAt, dump: dump.toString("base64")};
  });
}

async function writeValkeyKeys(port, entries, nowMs) {
  const live = entries.filter(({expireAtMs}) => expireAtMs === -1 || expireAtMs > nowMs);
  const replies = await respPipeline(port, live.map(({key, expireAtMs, dump}) => [
    "RESTORE", Buffer.from(key, "base64"), expireAtMs === -1 ? 0 : expireAtMs, Buffer.from(dump, "base64"), "REPLACE", "ABSTTL",
  ]));
  replies.forEach((reply, index) => {
    if (reply instanceof Error) restoreFail(`Valkey RESTORE failed for key ${live[index].key}: ${reply.message}`);
  });
  return {restored: live.length, skippedExpired: entries.length - live.length};
}

const TABLE_COUNT_SQL = `
select table_name || ' ' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE'
order by table_name`;

async function tableRowCounts(run, container) {
  const {stdout} = await run("docker", [
    "exec", "-e", "PGPASSWORD=wikijump", container, "psql", ...POSTGRES_CLIENT_ARGS, "-Atc", TABLE_COUNT_SQL,
  ], {capture: true});
  const counts = {};
  for (const line of stdout.trim().split("\n")) {
    const [table, count] = line.split(" ");
    counts[table] = Number(count);
  }
  return counts;
}

export async function minioListing(run, container, buckets) {
  const rows = [];
  for (const bucket of buckets) {
    const {stdout} = await run("docker", [
      "exec", container, "sh", "-c",
      `mc alias set seed http://127.0.0.1:9000 minio defaultpassword >/dev/null && mc ls -r --json seed/${bucket}`,
    ], {capture: true});
    for (const line of stdout.split("\n").filter(Boolean)) {
      const {key, size, etag} = JSON.parse(line);
      rows.push(`${bucket}/${key} ${size} ${etag}`);
    }
  }
  return rows.sort();
}

async function artifactRecord(directory, name) {
  const path = join(directory, name);
  return {bytes: (await stat(path)).size, sha256: await sha256File(path)};
}

export async function captureSeededStack({run, containers, ports, buckets, directory, key, inputs}) {
  await run("docker", [
    "exec", "-e", "PGPASSWORD=wikijump", containers.database, "pg_dump", ...POSTGRES_CLIENT_ARGS,
    "-Fc", "--no-owner", "-f", CONTAINER_DUMP_PATH,
  ], {capture: true});
  await run("docker", ["cp", `${containers.database}:${CONTAINER_DUMP_PATH}`, join(directory, POSTGRES_DUMP)], {capture: true});

  await run("docker", [
    "exec", containers.files, "sh", "-c",
    `rm -rf ${CONTAINER_EXPORT_DIR} && mkdir -p ${CONTAINER_EXPORT_DIR} && cp -a ${buckets.map((bucket) => `/data/${bucket}`).join(" ")} ${CONTAINER_EXPORT_DIR}/`,
  ], {capture: true});
  await dockerStreamToFile(["cp", `${containers.files}:${CONTAINER_EXPORT_DIR}`, "-"], join(directory, MINIO_ARCHIVE));

  const valkeyKeys = await readValkeyKeys(ports.cache);
  await writeFile(join(directory, VALKEY_KEYS), JSON.stringify(valkeyKeys));

  const expect = {
    tableRowCounts: await tableRowCounts(run, containers.database),
    minioListing: await minioListing(run, containers.files, buckets),
    valkeyKeyCount: valkeyKeys.length,
  };
  const artifacts = {};
  for (const name of [POSTGRES_DUMP, MINIO_ARCHIVE, VALKEY_KEYS]) artifacts[name] = await artifactRecord(directory, name);
  await writeFile(
    join(directory, SEED_CAPTURE_MANIFEST),
    JSON.stringify({format: SEED_CAPTURE_FORMAT, key, inputs, createdAt: new Date().toISOString(), artifacts, expect}, null, 2),
  );
  return {expect};
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function restoreSeedCapture({run, containers, ports, buckets, directory, expectedKey, now = Date.now}) {
  let manifest;
  try {
    manifest = await verifySeedCapture(directory, expectedKey);
  } catch (error) {
    restoreFail(error.message, error);
  }
  try {
    const database = containers.database;
    await run("docker", ["cp", join(directory, POSTGRES_DUMP), `${database}:${CONTAINER_DUMP_PATH}`], {capture: true});
    await run("docker", [
      "exec", "-e", "PGPASSWORD=wikijump", database, "pg_restore", ...POSTGRES_CLIENT_ARGS.slice(0, 4),
      "-d", "wikijump", "--exit-on-error", "--single-transaction", "--no-owner", CONTAINER_DUMP_PATH,
    ], {capture: true});
    await run("docker", [
      "exec", "-e", "PGPASSWORD=wikijump", database, "psql", ...POSTGRES_CLIENT_ARGS, "-qc", "ANALYZE",
    ], {capture: true});

    await dockerStreamFromFile(["cp", "-", `${containers.files}:/tmp`], join(directory, MINIO_ARCHIVE));
    await run("docker", [
      "exec", containers.files, "sh", "-c",
      `${buckets.map((bucket) => `cp -a ${CONTAINER_EXPORT_DIR}/${bucket}/. /data/${bucket}/`).join(" && ")} && rm -rf ${CONTAINER_EXPORT_DIR}`,
    ], {capture: true});

    const entries = JSON.parse(await readFile(join(directory, VALKEY_KEYS), "utf8"));
    if (entries.length !== manifest.expect.valkeyKeyCount) restoreFail("captured Valkey key list does not match its manifest");
    const {restored} = await writeValkeyKeys(ports.cache, entries, now());

    const [rowCounts, listing, keyCount] = await Promise.all([
      tableRowCounts(run, database),
      minioListing(run, containers.files, buckets),
      respSingle(ports.cache, "DBSIZE"),
    ]);
    if (!sameJson(rowCounts, manifest.expect.tableRowCounts)) restoreFail("restored PostgreSQL row counts differ from the capture");
    if (!sameJson(listing, manifest.expect.minioListing)) restoreFail("restored MinIO objects differ from the capture");
    if (keyCount > restored || keyCount < entries.filter(({expireAtMs}) => expireAtMs === -1).length) {
      restoreFail(`restored Valkey holds ${keyCount} keys, expected between the persistent keys and ${restored}`);
    }
  } catch (error) {
    if (error instanceof SeedCaptureRestoreError) throw error;
    restoreFail(`seed capture restore failed: ${error.message}`, error);
  }
}

export async function withSeedCaptureFallback(attempt, capture, {log = (message) => console.error(message)} = {}) {
  if (!capture) return attempt(null);
  let entered = false;
  try {
    return await attempt(capture, () => { entered = true; });
  } catch (error) {
    if (entered || !(error instanceof SeedCaptureRestoreError)) throw error;
    log(`Deepwell seed capture restore FAILED, seeding this stack the slow way instead: ${error.message}`);
    return attempt(null);
  }
}
