import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRosterManifest,
  captureUserKey,
  normalizeCaptureUser,
  verifyRosterManifest,
} from "../src/roster-import-manifest.mjs";
import { parseArgs } from "../scripts/build-roster-import-manifest.mjs";
import { sha256Hex, stableStringify } from "../src/canonical-json.mjs";

const FIXTURE_PROVENANCE = {
  capture_id: "fixture-capture-1",
  captured_at: "2026-10-20T00:00:00Z",
  collector: "wikidot.py",
};

const alice = { id: 101, name: "Alice", unix_name: "alice", avatar_url: null };
const bob = { id: 202, name: "Bob", unix_name: "bob", avatar_url: "http://example.invalid/a.png" };

test("user keys prefer numeric id over names", () => {
  assert.equal(captureUserKey(normalizeCaptureUser(alice, "u")), "id:101");
  assert.equal(
    captureUserKey(normalizeCaptureUser({ unix_name: "carol", name: "Carol" }, "u")),
    "unix:carol",
  );
  assert.equal(captureUserKey(normalizeCaptureUser({ name: "Dave" }, "u")), "name:Dave");
  assert.equal(captureUserKey(normalizeCaptureUser({ kind: "anonymous", ip: "127.0.0.2" }, "u")), "ip:127.0.0.2");
  assert.equal(normalizeCaptureUser({ id: 7, name: "Eve" }, "u").kind, "regular");
});

test("user normalization rejects keyless and mistyped roster entries", () => {
  assert.throws(() => normalizeCaptureUser({}, "u"), /no id, unix_name, name, or ip/);
  assert.throws(() => normalizeCaptureUser({ id: "101" }, "u"), /integer or null/);
  assert.throws(() => normalizeCaptureUser({ name: "x", kind: "robot" }, "u"), /unknown user kind/);
});

function voterCapture(pages) {
  return { kind: "voters", site: "scp-wiki", branch: "en", ...FIXTURE_PROVENANCE, pages };
}

test("voter manifests combine the baseline-free delta rows deterministically", () => {
  const capture = voterCapture([
    { page: "scp-9506", votes: [{ user: bob, value: -1 }, { user: alice, value: 1 }] },
    { page: "scp-173", votes: [{ user: alice, value: 1 }] },
  ]);
  const first = buildRosterManifest(capture);
  const second = buildRosterManifest(capture);
  assert.equal(first.manifest_sha256, second.manifest_sha256);
  const shuffled = voterCapture([...capture.pages].reverse().map((entry) => ({
    page: entry.page,
    votes: [...entry.votes].reverse(),
  })));
  const reordered = buildRosterManifest(shuffled);
  assert.deepEqual(reordered.rows, first.rows);
  assert.notEqual(reordered.provenance.capture_sha256, first.provenance.capture_sha256);
  assert.deepEqual(
    first.rows.map((row) => [row.page, row.user.id, row.value]),
    [["scp-173", 101, 1], ["scp-9506", 101, 1], ["scp-9506", 202, -1]],
  );
  assert.deepEqual(verifyRosterManifest(first, capture), { ok: true, problems: [] });
});

test("duplicate voter rows collapse only when the values agree", () => {
  const same = voterCapture([
    { page: "scp-1", votes: [{ user: alice, value: 1 }, { user: { ...alice }, value: 1 }] },
  ]);
  assert.equal(buildRosterManifest(same).row_count, 1);
  const conflict = voterCapture([
    { page: "scp-1", votes: [{ user: alice, value: 1 }, { user: { ...alice }, value: -1 }] },
  ]);
  assert.throws(() => buildRosterManifest(conflict), /conflicting vote values/);
});

test("non-integer vote values fail closed", () => {
  for (const value of [1.5, "1", null, Number.NaN]) {
    assert.throws(
      () => buildRosterManifest(voterCapture([{ page: "scp-1", votes: [{ user: alice, value }] }])),
      /integer vote value/,
      JSON.stringify(value),
    );
  }
});

test("watcher manifests dedupe subscribers without inventing rows", () => {
  const capture = {
    kind: "watchers",
    site: "scp-wiki",
    branch: "en",
    ...FIXTURE_PROVENANCE,
    pages: [
      { page: "scp-3352", watchers: [bob, alice, { ...bob }] },
      { page: "scp-173", watchers: [] },
    ],
  };
  const manifest = buildRosterManifest(capture);
  assert.deepEqual(
    manifest.rows.map((row) => [row.page, row.user.id]),
    [["scp-3352", 101], ["scp-3352", 202]],
  );
  assert.deepEqual(verifyRosterManifest(manifest, capture), { ok: true, problems: [] });
});

test("member manifests union roles and keep the earliest join date", () => {
  const capture = {
    kind: "members",
    site: "scp-wiki",
    branch: "en",
    ...FIXTURE_PROVENANCE,
    members: [
      { user: alice, joined_at: "2020-01-02T00:00:00Z" },
      { user: bob, joined_at: "2021-05-05T00:00:00Z" },
    ],
    moderators: [{ user: { ...alice }, joined_at: "2022-02-02T00:00:00Z" }],
    admins: [{ user: { ...bob }, joined_at: "2020-12-12T00:00:00Z" }],
  };
  const manifest = buildRosterManifest(capture);
  assert.deepEqual(manifest.rows, [
    { user: { kind: "regular", id: 101, unix_name: "alice", name: "Alice" }, roles: ["member", "moderator"], joined_at: "2020-01-02T00:00:00.000Z" },
    { user: { kind: "regular", id: 202, unix_name: "bob", name: "Bob", avatar_url: "http://example.invalid/a.png" }, roles: ["member", "admin"], joined_at: "2020-12-12T00:00:00.000Z" },
  ]);
  assert.deepEqual(verifyRosterManifest(manifest, capture), { ok: true, problems: [] });
});

test("deleted and anonymous roster entries pass through tagged, never dropped", () => {
  const capture = voterCapture([
    {
      page: "scp-1",
      votes: [
        { user: { name: "[deleted]", kind: "deleted" }, value: -1 },
        { user: { kind: "anonymous", ip: "127.0.0.2" }, value: 1 },
      ],
    },
  ]);
  const manifest = buildRosterManifest(capture);
  assert.equal(manifest.row_count, 2);
  assert.deepEqual(
    manifest.rows.map((row) => row.user.kind),
    ["anonymous", "deleted"],
  );
});

test("verify mode fails closed on malformed rows instead of throwing", () => {
  for (const manifest of [
    { schema: "wikijump.roster_import_manifest.v1", kind: "voters", rows: [{}, {}], row_count: 2, manifest_sha256: "x" },
    { schema: "wikijump.roster_import_manifest.v1", kind: "watchers", rows: [null], row_count: 1, manifest_sha256: "x" },
    { schema: "wikijump.roster_import_manifest.v1", kind: "voters", rows: [{ page: "scp-1", user: null }], row_count: 1, manifest_sha256: "x" },
    { schema: "wikijump.roster_import_manifest.v1", kind: "members", rows: [{ user: { id: 1 }, roles: "member" }], row_count: 1, manifest_sha256: "x" },
  ]) {
    assert.deepEqual(verifyRosterManifest(manifest, null).ok, false);
  }
});

test("joined_at keeps the earliest instant regardless of source spelling", () => {
  const capture = {
    kind: "members",
    site: "scp-wiki",
    branch: "en",
    ...FIXTURE_PROVENANCE,
    members: [{ user: { id: 101, name: "Alice" }, joined_at: "2024-06-01T00:00:00Z" }],
    moderators: [{ user: { id: 101, name: "Alice" }, joined_at: "2024-05-31T23:00:00-05:00" }],
    admins: [],
  };
  const manifest = buildRosterManifest(capture);
  assert.equal(manifest.rows[0].joined_at, "2024-06-01T00:00:00.000Z");
  const respelled = {
    ...capture,
    members: [{ user: { id: 101, name: "Alice" }, joined_at: "2024-06-01" }],
    moderators: [{ user: { id: 101, name: "Alice" }, joined_at: "2024-05-31T23:00:00-05:00" }],
  };
  assert.deepEqual(buildRosterManifest(respelled).rows, manifest.rows);
});

test("captured_at must be a datetime and roles stay canonical", () => {
  const capture = voterCapture([{ page: "scp-1", votes: [{ user: alice, value: 1 }] }]);
  assert.throws(() => buildRosterManifest({ ...capture, captured_at: "yesterday" }), /ISO-8601 datetime/);
  const members = buildRosterManifest({
    kind: "members",
    site: "scp-wiki",
    branch: "en",
    ...FIXTURE_PROVENANCE,
    members: [{ user: alice, joined_at: "2020-01-02T00:00:00Z" }],
    moderators: [{ user: { ...alice }, joined_at: "2022-02-02T00:00:00Z" }],
    admins: [],
  });
  const tamperedRoles = {
    ...members,
    rows: members.rows.map((row) => ({ ...row, roles: [...row.roles].reverse() })),
  };
  const { manifest_sha256: _dropped, ...tamperedBody } = tamperedRoles;
  tamperedRoles.manifest_sha256 = sha256Hex(stableStringify(tamperedBody));
  const result = verifyRosterManifest(tamperedRoles, null);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(";"), /canonical order/);
});

test("verify mode catches tampering, reorder, and capture drift", () => {
  const capture = voterCapture([{ page: "scp-1", votes: [{ user: alice, value: 1 }] }]);
  const manifest = buildRosterManifest(capture);
  const tampered = { ...manifest, rows: [{ page: "scp-1", user: { kind: "regular", id: 101 }, value: -1 }] };
  assert.equal(verifyRosterManifest(tampered, capture).ok, false);
  const twoPage = voterCapture([
    { page: "scp-2", votes: [{ user: bob, value: -1 }] },
    { page: "scp-1", votes: [{ user: alice, value: 1 }] },
  ]);
  const ordered = buildRosterManifest(twoPage);
  const reordered = { ...ordered, rows: [...ordered.rows].reverse() };
  assert.match(
    verifyRosterManifest(reordered, null).problems.join(";"),
    /canonical order|manifest_sha256/,
  );
  const drifted = voterCapture([{ page: "scp-1", votes: [{ user: alice, value: -1 }] }]);
  assert.match(
    verifyRosterManifest(manifest, drifted).problems.join(";"),
    /reproduce from the capture/,
  );
});

test("empty captures yield empty manifests that still verify", () => {
  for (const capture of [
    voterCapture([]),
    { kind: "watchers", site: "s", branch: "en", ...FIXTURE_PROVENANCE, pages: [] },
    { kind: "members", site: "s", branch: "en", ...FIXTURE_PROVENANCE, members: [], moderators: [], admins: [] },
  ]) {
    const manifest = buildRosterManifest(capture);
    assert.equal(manifest.row_count, 0);
    assert.deepEqual(verifyRosterManifest(manifest, capture), { ok: true, problems: [] });
  }
});

test("unknown kinds and malformed envelopes fail closed", () => {
  assert.throws(() => buildRosterManifest({ ...FIXTURE_PROVENANCE, kind: "bananas", site: "s", pages: [] }), /unknown roster kind/);
  assert.throws(() => buildRosterManifest(voterCapture([{ page: "", votes: [] }])), /non-empty string/);
  assert.throws(() => buildRosterManifest({ kind: "members", site: "", branch: "en", ...FIXTURE_PROVENANCE }), /non-empty string/);
  assert.throws(() => buildRosterManifest(voterCapture([{ page: "scp-1" }])), /votes array/);
});

test("CLI parses build and verify invocations", () => {
  assert.deepEqual(parseArgs(["--capture", "c.json", "--output", "m.json"]), {
    capture: "c.json",
    output: "m.json",
    manifest: null,
    verify: false,
  });
  assert.deepEqual(parseArgs(["--verify", "--manifest", "m.json", "--capture", "c.json"]), {
    capture: "c.json",
    output: null,
    manifest: "m.json",
    verify: true,
  });
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
});
