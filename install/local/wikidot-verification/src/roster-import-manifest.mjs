
import { codePointCompare, sha256Hex, stableStringify } from "./canonical-json.mjs";

export const ROSTER_MANIFEST_SCHEMA = "wikijump.roster_import_manifest.v1";

const USER_KINDS = new Set(["regular", "deleted", "anonymous", "guest", "wikidot"]);
const MEMBER_ROLES = new Set(["member", "moderator", "admin"]);

function fail(message) {
  throw new Error(`roster manifest: ${message}`);
}

function assertRecord(value, what) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`expected an object for ${what}`);
  }
  return value;
}

function assertNonEmptyString(value, what) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`expected a non-empty string for ${what}`);
  }
  return value;
}

function assertOptionalString(value, what) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(`expected a string or null for ${what}`);
  return value;
}

function assertOptionalInteger(value, what) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`expected an integer or null for ${what}`);
  }
  return value;
}

function assertOptionalIsoDateTime(value, what) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail(`expected an ISO-8601 datetime or null for ${what}`);
  }
  return new Date(value).toISOString();
}

function assertIsoDateTime(value, what) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail(`expected an ISO-8601 datetime for ${what}`);
  }
  return new Date(value).toISOString();
}

const CANONICAL_ROLE_ORDER = ["member", "moderator", "admin"];

function assertCanonicalRoles(value, what) {
  if (!Array.isArray(value)) fail(`expected a roles array for ${what}`);
  const seen = new Set();
  for (const role of value) {
    if (!MEMBER_ROLES.has(role) || seen.has(role)) {
      fail(`unexpected or duplicate member role for ${what}: ${JSON.stringify(role)}`);
    }
    seen.add(role);
  }
  const canonical = CANONICAL_ROLE_ORDER.filter((role) => seen.has(role));
  if (stableStringify(canonical) !== stableStringify(value)) {
    fail(`member roles for ${what} are not in canonical order ${JSON.stringify(canonical)}`);
  }
  return value;
}

export function normalizeCaptureUser(raw, what) {
  const user = assertRecord(raw, what);
  const id = assertOptionalInteger(user.id, `${what}.id`);
  const name = assertOptionalString(user.name, `${what}.name`);
  const unixName = assertOptionalString(user.unix_name, `${what}.unix_name`);
  const avatarUrl = assertOptionalString(user.avatar_url, `${what}.avatar_url`);
  const ip = assertOptionalString(user.ip, `${what}.ip`);
  let kind = "regular";
  if (user.kind !== undefined && user.kind !== null) {
    if (typeof user.kind !== "string" || !USER_KINDS.has(user.kind)) {
      fail(`unknown user kind for ${what}: ${JSON.stringify(user.kind)}`);
    }
    kind = user.kind;
  }
  if (id === null && unixName === null && name === null && ip === null) {
    fail(`user ${what} has no id, unix_name, name, or ip to key on`);
  }
  const normalized = { kind };
  if (id !== null) normalized.id = id;
  if (unixName !== null) normalized.unix_name = unixName;
  if (name !== null) normalized.name = name;
  if (avatarUrl !== null) normalized.avatar_url = avatarUrl;
  if (ip !== null) normalized.ip = ip;
  return normalized;
}

export function captureUserKey(user) {
  if (user.id !== undefined && user.id !== null) return `id:${user.id}`;
  if (user.unix_name !== undefined && user.unix_name !== null) return `unix:${user.unix_name}`;
  if (user.name !== undefined && user.name !== null) return `name:${user.name}`;
  return `ip:${user.ip}`;
}

function compareRows(left, right) {
  return (
    codePointCompare(left.page ?? "", right.page ?? "") ||
    codePointCompare(captureUserKey(left.user), captureUserKey(right.user))
  );
}

function normalizeVoteValue(raw, what) {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    fail(`expected an integer vote value for ${what}, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

function buildVoterRows(pages) {
  if (!Array.isArray(pages)) fail("voters capture needs a pages array");
  const rows = [];
  const seen = new Map();
  for (const entry of pages) {
    const page = assertNonEmptyString(assertRecord(entry, "pages[]").page, "pages[].page");
    const votes = assertRecord(entry, `pages[${page}]`).votes;
    if (!Array.isArray(votes)) fail(`expected a votes array for page ${page}`);
    for (const vote of votes) {
      const record = assertRecord(vote, `votes[] on ${page}`);
      const row = {
        page,
        user: normalizeCaptureUser(record.user, `voter on ${page}`),
        value: normalizeVoteValue(record.value, `vote on ${page}`),
      };
      const key = `${page}\u0000${captureUserKey(row.user)}`;
      const prior = seen.get(key);
      if (prior !== undefined) {
        if (prior !== row.value) {
          fail(`conflicting vote values for ${key}: ${prior} vs ${row.value}`);
        }
        continue;
      }
      seen.set(key, row.value);
      rows.push(row);
    }
  }
  rows.sort(compareRows);
  return rows;
}

function buildWatcherRows(pages) {
  if (!Array.isArray(pages)) fail("watchers capture needs a pages array");
  const rows = [];
  const seen = new Set();
  for (const entry of pages) {
    const page = assertNonEmptyString(assertRecord(entry, "pages[]").page, "pages[].page");
    const watchers = assertRecord(entry, `pages[${page}]`).watchers;
    if (!Array.isArray(watchers)) fail(`expected a watchers array for page ${page}`);
    for (const watcher of watchers) {
      const row = {
        page,
        user: normalizeCaptureUser(watcher, `watcher on ${page}`),
      };
      const key = `${page}\u0000${captureUserKey(row.user)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  rows.sort(compareRows);
  return rows;
}

function buildMemberRows(capture) {
  const lists = { member: [], moderator: [], admin: [] };
  for (const [key, role] of [["members", "member"], ["moderators", "moderator"], ["admins", "admin"]]) {
    const entries = capture[key] ?? [];
    if (!Array.isArray(entries)) fail(`expected an array for ${key}`);
    for (const item of entries) {
      const record = assertRecord(item, `${key}[]`);
      lists[role].push({
        user: normalizeCaptureUser(record.user, `${key}[] user`),
        joined_at: assertOptionalIsoDateTime(record.joined_at, `${key}[] joined_at`),
      });
    }
  }
  const merged = new Map();
  for (const role of ["member", "moderator", "admin"]) {
    const sorted = [...lists[role]].sort((left, right) =>
      codePointCompare(captureUserKey(left.user), captureUserKey(right.user)),
    );
    for (const { user, joined_at } of sorted) {
      const key = captureUserKey(user);
      let row = merged.get(key);
      if (row === undefined) {
        row = { user, roles: [], joined_at: null };
        merged.set(key, row);
      }
      if (!row.roles.includes(role)) row.roles.push(role);
      if (joined_at !== null && (row.joined_at === null || joined_at < row.joined_at)) {
        row.joined_at = joined_at;
      }
    }
  }
  const rows = [...merged.values()];
  rows.sort((left, right) =>
    codePointCompare(captureUserKey(left.user), captureUserKey(right.user)),
  );
  return rows;
}

function manifestBody({ kind, source, provenance, rows }) {
  return { schema: ROSTER_MANIFEST_SCHEMA, kind, source, provenance, rows, row_count: rows.length };
}

export function buildRosterManifest(capture) {
  const input = assertRecord(capture, "capture");
  const kind = input.kind;
  if (kind !== "voters" && kind !== "watchers" && kind !== "members") {
    fail(`unknown roster kind: ${JSON.stringify(kind)}`);
  }
  const source = {
    site: assertNonEmptyString(input.site, "site"),
    branch: assertNonEmptyString(input.branch ?? "en", "branch"),
  };
  const provenance = {
    collector: assertNonEmptyString(input.collector ?? "wikidot.py", "collector"),
    capture_id: assertNonEmptyString(input.capture_id, "capture_id"),
    captured_at: assertIsoDateTime(input.captured_at, "captured_at"),
    capture_sha256: sha256Hex(stableStringify(input)),
  };
  let rows;
  if (kind === "voters") rows = buildVoterRows(input.pages);
  else if (kind === "watchers") rows = buildWatcherRows(input.pages);
  else rows = buildMemberRows(input);
  const body = manifestBody({ kind, source, provenance, rows });
  return { ...body, manifest_sha256: sha256Hex(stableStringify(body)) };
}

export function verifyRosterManifest(manifest, capture = null) {
  const problems = [];
  const check = (ok, message) => {
    if (!ok) problems.push(message);
  };
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, problems: ["manifest is not an object"] };
  }
  check(manifest.schema === ROSTER_MANIFEST_SCHEMA, `unexpected schema ${JSON.stringify(manifest.schema)}`);
  check(
    manifest.kind === "voters" || manifest.kind === "watchers" || manifest.kind === "members",
    `unexpected kind ${JSON.stringify(manifest.kind)}`,
  );
  check(Array.isArray(manifest.rows), "rows is not an array");
  check(manifest.row_count === (Array.isArray(manifest.rows) ? manifest.rows.length : -1), "row_count mismatch");
  if (Array.isArray(manifest.rows)) {
    for (const row of manifest.rows) {
      try {
        assertRecord(row, "row");
        assertRecord(row.user, "row.user");
        if (manifest.kind === "members") assertCanonicalRoles(row.roles, "row.roles");
      } catch (error) {
        problems.push(error.message);
      }
    }
    if (problems.length === 0) {
      const sorted = [...manifest.rows].sort(
        manifest.kind === "members"
          ? (left, right) => codePointCompare(captureUserKey(left.user), captureUserKey(right.user))
          : compareRows,
      );
      check(
        stableStringify(sorted) === stableStringify(manifest.rows),
        "rows are not in canonical order",
      );
    }
  }
  const { manifest_sha256, ...body } = manifest;
  check(
    typeof manifest_sha256 === "string" && manifest_sha256 === sha256Hex(stableStringify(body)),
    "manifest_sha256 mismatch",
  );
  if (capture !== null && problems.length === 0) {
    let rebuilt;
    try {
      rebuilt = buildRosterManifest(capture);
    } catch (error) {
      return { ok: false, problems: [...problems, `capture rebuild failed: ${error.message}`] };
    }
    check(
      stableStringify(rebuilt) === stableStringify(manifest),
      "manifest does not reproduce from the capture",
    );
  }
  return { ok: problems.length === 0, problems };
}
