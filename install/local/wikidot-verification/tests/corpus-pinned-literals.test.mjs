import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import {
  ALLOWLIST_SCHEMA,
  DEFAULT_MAX_PINNED_CASES_FORTYFOLD_RARITY_GAP,
  MIN_FINDING_LENGTH_SIXTEEN_CHARACTER_FLOOR,
  REFERENCE_SCHEMA,
  analyzeRustSource,
  buildCorpusIndex,
  checkCorpusPinnedLiterals,
  locateInCorpus,
  matchingContextAt,
  scanRustLiterals,
  testModuleRanges,
  validateAllowlist,
} from "../src/corpus-pinned-literals.mjs";
import {parseArgs, usage} from "../scripts/check-corpus-pinned-literals.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const allowlist = (...entries) => ({schema: ALLOWLIST_SCHEMA, entries});
const reference = (caseId, source) => ({
  schema: REFERENCE_SCHEMA,
  syntax_case: {case_id: caseId, source},
});

const PINNED_NOTE = "NOTE: module end is at bottom of page";
const corpus = buildCorpusIndex([
  reference("en:scp-7992", `[[module ListPages limit="1" ${PINNED_NOTE}]]\n[[/module]]`),
  reference("cn:scp-7992", `[[module ListPages limit="1" ${PINNED_NOTE}]]\n[[/module]]`),
  ...Array.from({length: 30}, (unused, index) =>
    reference(`filler:${index}`, '[[module ListPages order="name"]]\n%%title%%\n[[/module]]'),
  ),
]);

const check = (sources, list = allowlist(), options = {}) =>
  checkCorpusPinnedLiterals({sources, corpus, allowlist: list, hashLiteral: sha256, ...options});

test("the lexer reads literals and ignores quotes in comments and lifetimes", () => {
  const source = [
    "fn a<'life>(x: &'life str) -> bool {",
    '    // a " quote in a line comment',
    '    /* and a " in a block comment */',
    "    let quote = '\"';",
    '    x == "real literal"',
    "}",
  ].join("\n");
  const literals = scanRustLiterals(source);
  assert.deepEqual(
    literals.map((literal) => literal.value),
    ["real literal"],
  );
  assert.equal(literals[0].line, 5);
});

test("escapes and raw strings survive extraction", () => {
  const literals = scanRustLiterals('let a = "he said \\"hi\\"\\n"; let b = r#"raw " here"#;');
  assert.deepEqual(
    literals.map((literal) => literal.value),
    ['he said "hi"\n', 'raw " here'],
  );
});

test("rarity in the corpus is what marks a literal as pinned", () => {
  assert.deepEqual(locateInCorpus(PINNED_NOTE, corpus), {
    total: 2,
    caseIds: ["en:scp-7992", "cn:scp-7992"],
    pinned: true,
  });
  const common = locateInCorpus("[[/module]]", corpus);
  assert.equal(common.pinned, false);
  assert.ok(common.total > DEFAULT_MAX_PINNED_CASES_FORTYFOLD_RARITY_GAP);
});

test("a literal absent from the corpus is not a finding", () => {
  assert.deepEqual(locateInCorpus('<div class="wj-footnote-list">', corpus), {
    total: 0,
    caseIds: [],
    pinned: false,
  });
});

test("only literals in a matching position count", () => {
  const source = [
    "fn f(head: &str) -> bool {",
    `    assert!(head.is_empty(), "${PINNED_NOTE}");`,
    `    head == "${PINNED_NOTE}"`,
    "}",
  ].join("\n");
  const findings = analyzeRustSource({path: "f.rs", source}, corpus);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
  assert.equal(findings[0].operator, "comparison");
  assert.deepEqual(findings[0].corpus_case_ids, ["en:scp-7992", "cn:scp-7992"]);
});

test("a concat! group is judged as the one string it spells", () => {
  const source = [
    "fn f(head: &str) -> bool {",
    "    head == concat!(",
    '        "NOTE: module end ",',
    '        "is at bottom of page",',
    "    )",
    "}",
  ].join("\n");
  const findings = analyzeRustSource({path: "f.rs", source}, corpus);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].literal, PINNED_NOTE);
});

test("method matchers and const declarations are matching positions", () => {
  for (const line of [
    `    lowercase.starts_with("${PINNED_NOTE}")`,
    `    const NOTE: &str = "${PINNED_NOTE}";`,
  ]) {
    const source = `fn f(lowercase: &str) {\n${line}\n}`;
    assert.equal(analyzeRustSource({path: "f.rs", source}, corpus).length, 1, line);
  }
});

test("byte-string comparisons on one line are matching positions", () => {
  const source = `fn f(b: &[u8]) -> bool {\n    b.get(0..4) != Some(&b"${PINNED_NOTE}"[..])\n}`;
  assert.equal(analyzeRustSource({path: "f.rs", source}, corpus).length, 1);
});

test("ordinary argument positions are not matching positions", () => {
  const source = `fn f() { log("${PINNED_NOTE}"); }`;
  assert.equal(matchingContextAt(source, source.indexOf('"NOTE')).matched, false);
  assert.deepEqual(analyzeRustSource({path: "f.rs", source}, corpus), []);
});

test("regression tests may hold corpus source", () => {
  const source = [
    "#[cfg(test)]",
    "mod tests {",
    "    #[test]",
    "    fn corpus_head_is_preserved() {",
    `        assert_eq!(head(), "${PINNED_NOTE}");`,
    "    }",
    "}",
  ].join("\n");
  assert.equal(testModuleRanges(source).length, 1);
  assert.deepEqual(analyzeRustSource({path: "f.rs", source}, corpus), []);
});

test("a brace inside a string does not end the test module early", () => {
  const source = [
    "#[cfg(test)]",
    "mod tests {",
    '    const BRACE: &str = "}";',
    `    const PINNED: &str = "${PINNED_NOTE}";`,
    "}",
    `fn outside(head: &str) -> bool { head == "${PINNED_NOTE}" }`,
  ].join("\n");
  const findings = analyzeRustSource({path: "f.rs", source}, corpus);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 6);
});

test("raising the threshold stops discriminating", () => {
  const source = 'fn f(h: &str) -> bool { h == "[[/module]]" }';
  assert.deepEqual(analyzeRustSource({path: "f.rs", source}, corpus), []);
  assert.equal(analyzeRustSource({path: "f.rs", source}, corpus, {maxCases: 999}).length, 1);
});

test("an allowlisted literal is acknowledged rather than reported", () => {
  const source = `fn f(h: &str) -> bool { h == "${PINNED_NOTE}" }`;
  const list = allowlist({
    file: "f.rs",
    literal_sha256: sha256(PINNED_NOTE),
    reason: "Wikidot rejects every variant of this head",
    live_evidence: ["preview probe A", "preview probe B"],
  });
  const report = check([{path: "f.rs", source}], list);
  assert.equal(report.status, "clean");
  assert.equal(report.findings.length, 0);
  assert.equal(report.acknowledged.length, 1);
  assert.equal(report.corpus_case_count, corpus.length);
});

test("an allowlist entry for another file does not silence this one", () => {
  const source = `fn f(h: &str) -> bool { h == "${PINNED_NOTE}" }`;
  const list = allowlist({
    file: "other.rs",
    literal_sha256: sha256(PINNED_NOTE),
    reason: "unrelated",
    live_evidence: ["probe A", "probe B"],
  });
  assert.equal(check([{path: "f.rs", source}], list).status, "corpus-pinned");
});

test("an allowlist entry without two live observations is rejected", () => {
  const base = {
    file: "f.rs",
    literal_sha256: sha256("x"),
    reason: "because",
    live_evidence: ["only one"],
  };
  assert.throws(() => validateAllowlist(allowlist(base)), /two live_evidence/u);
  assert.throws(
    () => validateAllowlist(allowlist({...base, live_evidence: ["a", "b"], reason: " "})),
    /needs a reason/u,
  );
  assert.throws(() => validateAllowlist({schema: "wrong", entries: []}), /invalid/u);
  assert.throws(
    () => validateAllowlist(allowlist({...base, live_evidence: ["a", "b"], literal_sha256: "AB"})),
    /SHA-256/u,
  );
});

test("duplicate allowlist entries are rejected", () => {
  const entry = {
    file: "f.rs",
    literal_sha256: sha256("x"),
    reason: "because",
    live_evidence: ["a", "b"],
  };
  assert.throws(() => validateAllowlist(allowlist(entry, {...entry})), /duplicate/u);
});

test("a corpus record that is not a live reference is rejected", () => {
  assert.throws(() => buildCorpusIndex([{syntax_case: {case_id: "a", source: "x"}}]), /not a/u);
  assert.throws(
    () => buildCorpusIndex([{schema: REFERENCE_SCHEMA, syntax_case: {}}]),
    /no captured source/u,
  );
  assert.throws(() => buildCorpusIndex([]), /no captured sources/u);
});

test("the checked-in allowlist is valid", () => {
  const list = JSON.parse(
    fs.readFileSync(
      new URL("../fixtures/corpus-pinned-literals/allowlist.json", import.meta.url),
      "utf8",
    ),
  );
  validateAllowlist(list);
});

test("a short rare literal is a notice, not a finding", () => {
  const short = "%%x%%";
  assert.ok(short.length < MIN_FINDING_LENGTH_SIXTEEN_CHARACTER_FLOOR);
  const shortCorpus = buildCorpusIndex([
    reference("one", `[[module ListPages]]${short}[[/module]]`),
    ...Array.from({length: 30}, (unused, index) =>
      reference(`filler:${index}`, "[[module ListPages]]\n[[/module]]"),
    ),
  ]);
  const report = checkCorpusPinnedLiterals({
    sources: [{path: "f.rs", source: `fn f(h: &str) -> bool { h == "${short}" }`}],
    corpus: shortCorpus,
    allowlist: allowlist(),
    hashLiteral: sha256,
  });
  assert.equal(report.status, "clean");
  assert.equal(report.findings.length, 0);
  assert.equal(report.notices.length, 1);
  assert.equal(report.notices[0].severity, "notice");
});

test("the CLI parses its options and requires a corpus", () => {
  assert.deepEqual(parseArgs(["--corpus", "refs.jsonl", "--json", "some/path"]), {
    allowlist:
      "install/local/wikidot-verification/fixtures/corpus-pinned-literals/allowlist.json",
    corpus: ["refs.jsonl"],
    maxCases: DEFAULT_MAX_PINNED_CASES_FORTYFOLD_RARITY_GAP,
    strict: false,
    json: true,
    paths: ["some/path"],
  });
  assert.equal(parseArgs(["--corpus", "a.jsonl", "--strict"]).strict, true);
  assert.deepEqual(parseArgs(["--", "--corpus", "a.jsonl"]).corpus, ["a.jsonl"]);
  assert.equal(parseArgs(["--corpus", "a.jsonl", "--corpus", "b.jsonl"]).corpus.length, 2);
  assert.equal(parseArgs(["--corpus", "a.jsonl", "--max-cases", "20"]).maxCases, 20);
  assert.deepEqual(parseArgs(["--help"]), {help: true});
  assert.throws(() => parseArgs([]), /--corpus is required/u);
  assert.throws(() => parseArgs(["--nope"]), /unknown option/u);
  assert.throws(() => parseArgs(["--corpus"]), /requires a value/u);
  assert.throws(() => parseArgs(["--corpus", "a", "--max-cases", "0"]), /positive integer/u);
  assert.match(usage(), /corpus-pinned/u);
});
