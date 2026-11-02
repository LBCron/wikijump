import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const PASS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INDEX_SCHEMA = "wikijump.validation_pass_cache.v1";

const sortValue = (value) => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function passCacheKey(inputs) {
  return sha256(JSON.stringify(sortValue(inputs)));
}

export function validationEnvironmentDigest(env = process.env) {
  const names = Object.keys(env).filter((name) => /^(?:WIKIJUMP_|WIKIDOT_|PREFLIGHT_|THEME_LAB_|CARGO_|RUST)/u.test(name)).sort();
  return {names, sha256: sha256(JSON.stringify(names.map((name) => [name, env[name]])))};
}

const indexPath = (store, key) => path.join(store, "pass-cache", `${key}.json`);

export async function readCachedPass({store, key, now = Date.now(), maxAgeMs = PASS_CACHE_MAX_AGE_MS}) {
  let entry;
  try {
    entry = JSON.parse(await fs.readFile(indexPath(store, key), "utf8"));
  } catch {
    return {miss: "no cached PASS for these inputs"};
  }
  if (entry?.schema !== INDEX_SCHEMA || entry.key !== key) return {miss: "cache entry is malformed"};
  let bytes;
  try {
    bytes = await fs.readFile(entry.receipt_path);
  } catch {
    return {miss: "cached receipt is gone"};
  }
  if (sha256(bytes) !== entry.receipt_sha256) return {miss: "cached receipt changed since it was recorded"};
  const receipt = JSON.parse(bytes.toString("utf8"));
  if (receipt.status !== "pass") return {miss: "cached receipt is not a pass"};
  const completed = Date.parse(receipt.completed_at);
  if (!Number.isFinite(completed) || now - completed > maxAgeMs) return {miss: "cached PASS is older than the reuse window"};
  try {
    const log = await fs.readFile(receipt.preflight.log.path);
    if (sha256(log) !== receipt.preflight.log.sha256) return {miss: "cached validation log changed"};
  } catch {
    return {miss: "cached validation log is gone"};
  }
  return {receipt, receiptPath: entry.receipt_path, receiptSha256: entry.receipt_sha256};
}

export async function recordPass({store, key, receiptPath, receiptSha256, environmentNames}) {
  const file = indexPath(store, key);
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({
    schema: INDEX_SCHEMA, key, receipt_path: receiptPath, receipt_sha256: receiptSha256,
    environment_names: environmentNames,
  }, null, 2)}\n`, {mode: 0o600});
  await fs.rename(temporary, file);
}
