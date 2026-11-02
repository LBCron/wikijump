import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const artifactUrl = new URL(
  "../artifacts/ratings-actor-tie-live-20260914.json",
  import.meta.url,
);

const ARTIFACT_SHA256 =
  "620e00d1873148be791c41b7f28c6a5ff5c4ea0f4796a872db6602bc9d61d6ff";

async function readArtifact() {
  const bytes = await readFile(artifactUrl);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    ARTIFACT_SHA256,
    "retained ratings evidence must be byte-identical to the sealed capture summary",
  );
  return JSON.parse(bytes.toString("utf8"));
}

test("the retained summary is bound to the sealed live run and receipt", async () => {
  const artifact = await readArtifact();

  assert.equal(artifact.schema, "wikijump.ratings_actor_tie_live.v1");
  assert.equal(artifact.observed_at, "2026-09-14");
  assert.equal(artifact.site, "sandbox-for-codex");
  assert.equal(artifact.site_origin, "http://sandbox-for-codex.wikidot.com");
  assert.equal(artifact.run_id, "ratings-batch-20260914-r1");
  assert.deepEqual(artifact.source_artifact, {
    path: "/home/roku/wjlab/evidence/ratings-batch-20260914-r1/artifact.json",
    sha256:
      "c2db588a26a59f6a5dfc5e6f4b76e96a1ff0119a4f36af869dc7203e4dd3dd2e",
  });
  assert.deepEqual(artifact.source_receipt, {
    path: "/home/roku/wjlab/evidence/ratings-batch-20260914-r1/receipt.json",
    sha256:
      "d40f5b9566bcccfd97a3d4f98cb08e255665560301638be891c620aa5f9d6415",
  });
  assert.deepEqual(artifact.actor_classes, [
    "anonymous",
    "non_member",
    "member",
    "moderator",
    "administrator",
  ]);
  assert.equal(artifact.credentials_in_evidence, false);
});

test("RatedPages keeps unrated rows and orders equal scores by title", async () => {
  const artifact = await readArtifact();
  const rated = artifact.rated_pages;

  assert.equal(rated.category, "rat-260914r1-pm");
  assert.equal(rated.observer, "rat-260914r1-ob:obs");
  assert.deepEqual(
    rated.sections.default.map(({ fullname, rating }) => [fullname, rating]),
    [
      ["rat-260914r1-pm:bonly", 1],
      ["rat-260914r1-pm:eq1", 0],
      ["rat-260914r1-pm:eq2", 0],
      ["rat-260914r1-pm:unrated", 0],
      ["rat-260914r1-pm:pmholder", 0],
      ["rat-260914r1-pm:low", -1],
    ],
  );
  assert.deepEqual(rated.equal_score_titles, [
    "AA equal one",
    "BB equal two",
    "CC unrated",
    "MM pmholder",
  ]);
  assert.deepEqual(
    rated.sections.rating_asc.map(({ fullname }) => fullname),
    [
      "rat-260914r1-pm:low",
      "rat-260914r1-pm:eq1",
      "rat-260914r1-pm:eq2",
      "rat-260914r1-pm:unrated",
      "rat-260914r1-pm:pmholder",
      "rat-260914r1-pm:bonly",
    ],
  );
  assert.deepEqual(
    rated.sections.rate_asc.map(({ fullname }) => fullname),
    rated.sections.rating_asc.map(({ fullname }) => fullname),
    "the documented rate-asc spelling must alias rating-asc",
  );
  assert.deepEqual(
    rated.sections.min_rating_one.map(({ fullname }) => fullname),
    ["rat-260914r1-pm:bonly"],
    "minRating=1 must exclude every unrated row",
  );
  assert.deepEqual(
    rated.sections.max_rating_zero.map(({ fullname }) => fullname),
    [
      "rat-260914r1-pm:eq1",
      "rat-260914r1-pm:eq2",
      "rat-260914r1-pm:unrated",
      "rat-260914r1-pm:pmholder",
      "rat-260914r1-pm:low",
    ],
  );
  assert.equal(rated.unrated_fullname, "rat-260914r1-pm:unrated");
  assert.equal(rated.unrated_label, "(Rating: 0)");
  assert.equal(rated.actor_independent, true);
  assert.deepEqual(Object.keys(rated.fragment_sha256).sort(), [
    "Q809_CREATED_DESC",
    "Q809_DEFAULT",
    "Q809_MAX_RATING",
    "Q809_MIN_RATING",
    "Q809_RATE_ASC",
    "Q809_RATING_ASC",
  ]);
  for (const sha of Object.values(rated.fragment_sha256)) {
    assert.match(sha, /^[0-9a-f]{64}$/u);
  }
});

test("NextPage title ties select the first-created page and repeats are stable", async () => {
  const artifact = await readArtifact();
  const ties = artifact.next_previous_page.title_ties;

  assert.equal(ties.category, "rat-260914r1-np");
  assert.equal(ties.tie_title, "NN tie");
  assert.equal(ties.first_created, "rat-260914r1-np:zz-tie");
  assert.equal(ties.second_created, "rat-260914r1-np:aa-tie");
  assert.equal(ties.next_holder, "rat-260914r1-np:tnextholder");
  assert.equal(ties.next_selected, "rat-260914r1-np:zz-tie|NN tie");
  assert.equal(ties.next_fragment_sha256, ties.next_repeat_fragment_sha256);
  assert.equal(
    ties.previous_holder,
    "rat-260914r1-np:tprevholder",
    "the live PreviousPage title quirk is inclusive and returns the holder",
  );
  assert.equal(
    ties.previous_selected,
    "rat-260914r1-np:tprevholder|OO prev tie holder",
  );
  assert.equal(
    ties.previous_fragment_sha256,
    ties.previous_repeat_fragment_sha256,
  );
});

test("adjacency names a private page for every actor while direct reads enforce view", async () => {
  const artifact = await readArtifact();
  const adjacency = artifact.next_previous_page.private_adjacency;

  assert.equal(adjacency.private_category, "rat-260914r1-pr");
  assert.equal(adjacency.requested_permissions, "v:m");
  assert.equal(adjacency.previous_holder, "rat-260914r1-np:prevholder");
  assert.equal(adjacency.previous_private_page, "rat-260914r1-pr:nppriv");
  assert.equal(
    adjacency.previous_selection,
    "rat-260914r1-pr:nppriv|PP private previous",
  );
  assert.equal(adjacency.next_holder, "rat-260914r1-np:nextholder");
  assert.equal(adjacency.next_private_page, "rat-260914r1-pr:npprivnext");
  assert.equal(
    adjacency.next_selection,
    "rat-260914r1-pr:npprivnext|PP private next",
  );
  for (const named_for of [
    adjacency.previous_named_for,
    adjacency.next_named_for,
  ]) {
    assert.deepEqual(
      named_for,
      artifact.actor_classes,
      "the adjacency modules are not actor-scoped",
    );
  }
  assert.equal(adjacency.direct_reads.anonymous.http_status, 200);
  assert.equal(adjacency.direct_reads.anonymous.content_marker_present, false);
  assert.equal(adjacency.direct_reads.non_member.http_status, 200);
  assert.equal(adjacency.direct_reads.non_member.content_marker_present, false);
  assert.equal(adjacency.direct_reads.member.http_status, 200);
  assert.equal(adjacency.direct_reads.member.content_marker_present, true);
  assert.match(adjacency.direct_reads.anonymous.denial_state, /Private content/u);
});

test("authorized Ajax previews share the saved selection and anonymous previews are denied", async () => {
  const artifact = await readArtifact();
  const ajax = artifact.next_previous_page.ajax_preview;

  assert.equal(ajax.module_name, "edit/PagePreviewModule");
  assert.deepEqual(ajax.request_fields, [
    "mode=page",
    "source",
    "page_unix_name",
    "pageId",
  ]);
  assert.equal(ajax.authorized_status, "ok");
  assert.match(ajax.authorized_previous_body_sha256, /^[0-9a-f]{64}$/u);
  assert.match(ajax.authorized_next_body_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(ajax.anonymous_status, "wrong_token7");
  assert.equal(ajax.anonymous_body_bytes, 0);
  assert.equal(ajax.no_context_status, "ok", "the negative control still responds");
  assert.match(ajax.no_context_body_sha256, /^[0-9a-f]{64}$/u);
});

test("an empty adjacency result selects a later-created page at request time", async () => {
  const artifact = await readArtifact();
  const requestTime = artifact.next_previous_page.request_time;

  assert.equal(requestTime.holder, "rat-260914r1-np:rtnext");
  assert.equal(requestTime.initial_selection_count, 0);
  assert.equal(requestTime.late_page, "rat-260914r1-np:rtlate");
  assert.equal(
    requestTime.after_late_selection,
    "rat-260914r1-np:rtlate|XX rt late",
  );
  assert.notEqual(
    requestTime.initial_fragment_sha256,
    requestTime.after_late_fragment_sha256,
    "the module must re-evaluate the request-time page set",
  );
});

test("Rate widget control state is fixed across actors and rating modes", async () => {
  const artifact = await readArtifact();
  const rate = artifact.rate_module;

  assert.deepEqual(rate.plus_minus.controls, [
    "rateup",
    "ratedown",
    "cancel",
  ]);
  assert.deepEqual(rate.plus_minus.actor_classes, artifact.actor_classes);
  assert.equal(rate.plus_minus.existing_vote.page, "rat-260914r1-pm:eq1");
  assert.deepEqual(rate.plus_minus.existing_vote.voters, ["B", "C"]);
  for (const mode of [rate.plus_minus, rate.plus_minus.existing_vote]) {
    assert.match(mode.served_fragment_sha256, /^[0-9a-f]{64}$/u);
    assert.match(mode.settled_fragment_sha256, /^[0-9a-f]{64}$/u);
  }
  assert.match(
    rate.plus_minus.served_widget_html,
    /class="rateup btn btn-default"[\s\S]*class="ratedown btn btn-default"[\s\S]*class="cancel btn btn-default"/u,
  );

  assert.equal(rate.stars.data_rating, "0");
  assert.deepEqual(rate.stars.star_images, Array(5).fill("star-off"));
  assert.equal(rate.stars.cancel, false);
  assert.equal(rate.stars.existing_vote.page, "rat-260914r1-st:stvoted");
  assert.equal(rate.stars.existing_vote.voter, "B");
  assert.equal(rate.stars.existing_vote.data_rating, "4");
  assert.deepEqual(rate.stars.existing_vote.star_images, [
    "star-on",
    "star-on",
    "star-on",
    "star-on",
    "star-off",
  ]);

  assert.equal(rate.disabled_plus.mode, "draP");
  assert.deepEqual(rate.disabled_plus.controls, ["rateup", "cancel"]);
  assert.equal(rate.disabled_plus.ratedown, false);
  assert.match(
    rate.disabled_plus.served_widget_html,
    /class="rateup btn btn-default"[\s\S]*class="cancel btn btn-default"/u,
  );
  assert.doesNotMatch(
    rate.disabled_plus.served_widget_html,
    /class="ratedown btn btn-default"/u,
  );
});

test("the run cleaned up and recorded its remaining unknowns", async () => {
  const artifact = await readArtifact();

  assert.deepEqual(artifact.cleanup, {
    settings_restored: true,
    permissions_restored: true,
    pages_deleted: 21,
    pages_failed_delete: 0,
    absence_verified: true,
    category_residue: false,
  });
  assert.equal(artifact.missing_observations.length, 4);
  assert.ok(
    artifact.missing_observations.some((note) => note.includes("wrong_token7")),
    "the unobserved connector-level token gate must stay recorded",
  );
  assert.ok(
    artifact.missing_observations.some((note) =>
      note.includes("default-template body"),
    ),
    "the unobserved private body boundary must stay recorded",
  );

  const serialized = JSON.stringify(artifact);
  assert.doesNotMatch(
    serialized,
    /WIKIDOT_SESSION_ID|wikidot_token7|lock_secret|set-cookie|authorization/iu,
  );
});
