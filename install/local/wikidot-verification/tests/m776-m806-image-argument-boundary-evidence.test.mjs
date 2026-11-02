import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const referenceUrl = new URL(
  "../artifacts/m776-m806-image-argument-boundary-live.jsonl",
  import.meta.url,
);

const ARTIFACT_SHA256 =
  "3014b4f94fc5b2787f3fd0d97854b58baa6bf66db0fe2ef11d967baa7ceaa961";

const CASE_IDS = [
  "m776-width-doc-quoted-px",
  "m776-width-unquoted-px",
  "m776-width-quoted-number",
  "m776-width-unquoted-number",
  "m776-width-percent",
  "m776-width-empty",
  "m776-size-small-quoted",
  "m776-size-small-unquoted",
  "m776-size-thumbnail-quoted",
  "m776-size-invalid",
  "m776-source-double-quoted",
  "m776-source-single-quoted",
  "m776-float-left",
  "m776-float-right",
  "m776-float-left-lookalike",
  "m776-float-token-separated",
  "m806-width-doc-quoted-px",
  "m806-width-unquoted-px",
  "m806-width-quoted-number",
  "m806-width-unquoted-number",
  "m806-width-percent",
  "m806-width-empty",
  "m806-size-small-quoted",
  "m806-size-small-unquoted",
  "m806-size-thumbnail-quoted",
  "m806-size-invalid",
  "m806-source-double-quoted",
  "m806-source-single-quoted",
  "m806-center-token-separated",
  "m806-center-double-token-separated",
  "m776-local-size-square",
  "m776-local-size-thumbnail",
  "m776-local-size-small",
  "m776-local-size-invalid",
  "m776-local-size-empty",
  "m776-local-size-unquoted",
  "m806-local-size-square",
  "m806-local-size-thumbnail",
  "m806-local-size-small",
  "m806-local-size-invalid",
  "m806-local-size-empty",
  "m806-local-size-unquoted",
];

const WDFILES = "http://sandbox-for-codex.wdfiles.com";
const EXTERNAL = "https://example.com/a.png";

async function readReferences() {
  const bytes = await readFile(referenceUrl);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    ARTIFACT_SHA256,
    "retained evidence artifact must be byte-identical to the sealed acquisition",
  );
  return bytes
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function rawHtml(references, caseId) {
  const reference = references.find(
    ({ syntax_case: syntaxCase }) => syntaxCase.case_id === caseId,
  );
  assert.ok(reference, `missing retained reference for ${caseId}`);
  return reference.raw_html;
}

test("retained image argument boundary evidence keeps its anonymous preview provenance", async () => {
  const references = await readReferences();

  assert.deepEqual(
    references.map(({ syntax_case: syntaxCase }) => syntaxCase.case_id),
    CASE_IDS,
  );
  for (const reference of references) {
    assert.equal(
      reference.schema,
      "wikijump_syntax_differential.wikidot_reference.v1",
    );
    assert.equal(reference.provenance.authenticated, false);
    assert.equal(reference.provenance.mutated, false);
    assert.equal(reference.provenance.module, "edit/PagePreviewModule");
    assert.equal(reference.provenance.site, "sandbox-for-codex");
    assert.match(reference.source_sha256, /^[0-9a-f]{64}$/u);
    assert.match(reference.raw_html_sha256, /^[0-9a-f]{64}$/u);
  }
});

test("quoted width values are emitted and unquoted width pairs stay inert", async () => {
  const references = await readReferences();

  for (const prefix of ["m776", "m806"]) {
    for (const [suffix, width] of [
      ["doc-quoted-px", 'width="200px"'],
      ["quoted-number", 'width="200"'],
      ["percent", 'width="50%"'],
    ]) {
      const html = rawHtml(references, `${prefix}-width-${suffix}`);
      assert.ok(html.includes(width), `${prefix}-width-${suffix}: ${html}`);
      assert.ok(
        html.includes(`src="${EXTERNAL}"`),
        `${prefix}-width-${suffix}: ${html}`,
      );
    }

    const empty = rawHtml(references, `${prefix}-width-empty`);
    assert.ok(empty.includes('width=""'), `${prefix}-width-empty: ${empty}`);

    for (const suffix of ["unquoted-px", "unquoted-number"]) {
      const html = rawHtml(references, `${prefix}-width-${suffix}`);
      assert.ok(
        !html.includes(" width="),
        `${prefix}-width-${suffix} must ignore the unquoted pair: ${html}`,
      );
    }
  }
});

test("external URL size arguments never change the external source", async () => {
  const references = await readReferences();

  for (const prefix of ["m776", "m806"]) {
    for (const suffix of [
      "size-small-quoted",
      "size-small-unquoted",
      "size-thumbnail-quoted",
      "size-invalid",
    ]) {
      const html = rawHtml(references, `${prefix}-${suffix}`);
      assert.ok(
        html.includes(`src="${EXTERNAL}"`),
        `${prefix}-${suffix}: ${html}`,
      );
      assert.ok(
        !html.includes("resized-images") && !html.includes("size="),
        `${prefix}-${suffix} must not resize or emit size: ${html}`,
      );
    }
  }
});

test("quoted source spelling stays part of the authored source value", async () => {
  const references = await readReferences();

  for (const prefix of ["m776", "m806"]) {
    const doubleQuoted = rawHtml(references, `${prefix}-source-double-quoted`);
    assert.ok(
      doubleQuoted.includes('src="&quot;https://example.com/a.png&quot;"'),
      `${prefix}-source-double-quoted: ${doubleQuoted}`,
    );

    const singleQuoted = rawHtml(references, `${prefix}-source-single-quoted`);
    assert.ok(
      singleQuoted.includes(`src="'https://example.com/a.png'"`),
      `${prefix}-source-single-quoted: ${singleQuoted}`,
    );
  }
});

test("float and centered token boundaries keep lookalikes literal", async () => {
  const references = await readReferences();

  const left = rawHtml(references, "m776-float-left");
  assert.ok(left.includes('class="image-container floatleft"'), left);
  const right = rawHtml(references, "m776-float-right");
  assert.ok(right.includes('class="image-container floatright"'), right);

  for (const [caseId, literal] of [
    ["m776-float-left-lookalike", "[[ff&lt;image "],
    ["m776-float-token-separated", "[[f &gt;image "],
    ["m806-center-token-separated", "[[= image "],
    ["m806-center-double-token-separated", "[[== image "],
  ]) {
    const html = rawHtml(references, caseId);
    assert.ok(html.includes(literal), `${caseId}: ${html}`);
    assert.ok(!html.includes("<img "), `${caseId} must stay literal: ${html}`);
    assert.ok(
      html.includes(
        `<a href="${EXTERNAL}">${EXTERNAL}</a>`,
      ),
      `${caseId} keeps ordinary automatic-link ownership: ${html}`,
    );
  }
});

test("local image sizes select the named resize while invalid forms render the original", async () => {
  const references = await readReferences();

  for (const prefix of ["m776", "m806"]) {
    const className =
      prefix === "m776" ? "image-container" : "image-container aligncenter";

    for (const suffix of ["square", "thumbnail", "small"]) {
      const caseId = `${prefix}-local-size-${suffix}`;
      const html = rawHtml(references, caseId);
      assert.ok(
        html.includes(
          `<a href="${WDFILES}/local--files//photo.png"><img src="${WDFILES}/local--resized-images//photo.png/${suffix}.jpg"`,
        ),
        `${caseId}: ${html}`,
      );
      assert.ok(html.includes(`<div class="${className}">`), `${caseId}: ${html}`);
    }

    for (const suffix of ["invalid", "empty", "unquoted"]) {
      const caseId = `${prefix}-local-size-${suffix}`;
      const html = rawHtml(references, caseId);
      assert.ok(
        html.includes(`<div class="${className}"><img src="${WDFILES}/local--files//photo.png" alt="photo.png" class="image" /></div>`),
        `${caseId}: ${html}`,
      );
      assert.ok(!html.includes("local--resized-images"), `${caseId}: ${html}`);
      assert.ok(!html.includes("<a "), `${caseId}: ${html}`);
    }
  }
});
