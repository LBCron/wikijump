import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requirePlainObject(value, name) {
  if (!isPlainObject(value)) throw new Error(`${name} must be a JSON object`);
  return value;
}

export function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

export function requireSha256(value, name) {
  if (!isSha256(value)) throw new Error(`${name} must be a lowercase SHA-256`);
  return value;
}

export function requireExactHttpsOrigins(values, name) {
  if (!Array.isArray(values) || new Set(values).size !== values.length) {
    throw new Error(`${name} must be a unique array of exact HTTPS origins`);
  }
  return Object.freeze(values.map((value) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} must contain exact HTTPS origins`);
    }
    if (
      typeof value !== "string" ||
      value !== url.origin ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port
    ) {
      throw new Error(`${name} must contain exact HTTPS origins`);
    }
    return value;
  }));
}

const MAX_STABLE_FILE_BYTES = 128 * 1024 * 1024;

function requireStableRegularFile(stat, name) {
  if (
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    (stat.nlink !== 1n && stat.nlink !== 1)
  ) {
    throw new Error(`${name} must be a regular file`);
  }
  if (stat.size > BigInt(MAX_STABLE_FILE_BYTES)) {
    throw new Error(`${name} exceeds the maximum size`);
  }
}

function stableFileFingerprint(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    nlink: String(stat.nlink),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function requireSameStableFileFingerprint(before, after, name) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`${name} changed while it was being read`);
  }
}

export async function readStableRegularFile(filePath, name) {
  const beforeStat = await fs
    .lstat(filePath, {bigint: true})
    .catch(() => null);
  requireStableRegularFile(beforeStat, name);
  const before = stableFileFingerprint(beforeStat);
  if (!fsConstants.O_NOFOLLOW) {
    throw new Error("stable file verification requires O_NOFOLLOW support");
  }
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  let bytes;
  try {
    const openedStat = await handle.stat({bigint: true});
    requireStableRegularFile(openedStat, name);
    requireSameStableFileFingerprint(
      before,
      stableFileFingerprint(openedStat),
      name,
    );
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const afterStat = await fs
    .lstat(filePath, {bigint: true})
    .catch(() => null);
  requireStableRegularFile(afterStat, name);
  requireSameStableFileFingerprint(
    before,
    stableFileFingerprint(afterStat),
    name,
  );
  return Object.freeze({
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error("canonical JSON input contains an unsupported value");
}

export function canonicalJson(value) {
  return `${JSON.stringify(stableValue(value))}\n`;
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Value(value) {
  return sha256Text(canonicalJson(value));
}

export async function sha256File(filePath) {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

export async function readJsonObject(filePath, name = filePath) {
  const value = JSON.parse(await fs.readFile(filePath, "utf8"));
  return requirePlainObject(value, name);
}

export async function createPrivateEmptyDirectory(directory) {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`output directory already exists: ${directory}`);
    }
    throw error;
  }
  await fs.chmod(directory, 0o700);
}

export async function writeJson(destination, value) {
  await fs.writeFile(destination, `${canonicalJson(value)}`, { mode: 0o600, flag: "wx" });
}

export function normalizedUrl(value, name) {
  const url = new URL(requireNonEmptyString(value, name));
  if (
    !new Set(["http:", "https:"]).has(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(`${name} must be an unauthenticated HTTP(S) URL`);
  }
  return url;
}

export function sortedUniqueStrings(values, name) {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string" || value === "")
  ) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  const result = [...new Set(values)].sort();
  if (
    result.length !== values.length ||
    values.some((value, index) => value !== result[index])
  ) {
    throw new Error(`${name} must be sorted with no duplicates`);
  }
  return result;
}
