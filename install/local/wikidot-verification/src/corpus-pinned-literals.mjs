
export const ALLOWLIST_SCHEMA =
  "wikijump_compat.corpus_pinned_literals.allowlist.v1";
export const REPORT_SCHEMA = "wikijump_compat.corpus_pinned_literals.report.v1";

const MATCH_OPERATOR_TAILS = [
  {pattern: /(?:==|!=)\s*$/u, operator: "comparison"},
  {
    pattern:
      /\.(starts_with|ends_with|contains|find|rfind|strip_prefix|strip_suffix|eq_ignore_ascii_case|trim_matches|trim_start_matches|trim_end_matches|split|splitn|split_once|rsplit_once|replace)\(\s*$/u,
    operator: "method",
  },
  {pattern: /:\s*&(?:'[a-z_]+\s+)?str\s*=\s*$/u, operator: "const"},
];
const CONCAT_TAIL = /concat!\(\s*$/u;
const LINE_MATCH_FALLBACK = /(?:==|!=|matches!\()/u;

const CONTEXT_WINDOW = 160;
export function scanRustLiterals(source) {
  const literals = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (character === "'") {
      const closing = source.indexOf("'", index + 1);
      const span = closing === -1 ? Infinity : closing - index;
      if (span <= 4 && !/^'[A-Za-z_][A-Za-z0-9_]*$/u.test(source.slice(index, closing))) {
        index = closing + 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (character === "r" || character === "b") {
      const rawStart = matchRawStringStart(source, index);
      if (rawStart) {
        const closing = source.indexOf(rawStart.terminator, rawStart.contentStart);
        const end = closing === -1 ? source.length : closing + rawStart.terminator.length;
        literals.push({
          start: index,
          end,
          value: source.slice(rawStart.contentStart, closing === -1 ? source.length : closing),
          raw: true,
        });
        index = end;
        continue;
      }
    }
    if (character === '"') {
      const literal = readQuotedLiteral(source, index);
      literals.push(literal);
      index = literal.end;
      continue;
    }
    index += 1;
  }
  return literals.map((literal) => ({
    ...literal,
    line: lineNumberAt(source, literal.start),
  }));
}

function matchRawStringStart(source, index) {
  let cursor = index;
  if (source[cursor] === "b") cursor += 1;
  if (source[cursor] !== "r") return null;
  cursor += 1;
  let hashes = 0;
  while (source[cursor] === "#") {
    hashes += 1;
    cursor += 1;
  }
  if (source[cursor] !== '"') return null;
  return {contentStart: cursor + 1, terminator: `"${"#".repeat(hashes)}`};
}

function readQuotedLiteral(source, start) {
  let cursor = start + 1;
  let value = "";
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      const escaped = source[cursor + 1];
      if (escaped === "n") value += "\n";
      else if (escaped === "t") value += "\t";
      else if (escaped === "r") value += "\r";
      else if (escaped === "0") value += "\0";
      else if (escaped !== undefined) value += escaped;
      cursor += 2;
      continue;
    }
    if (character === '"') {
      return {start, end: cursor + 1, value, raw: false};
    }
    value += character;
    cursor += 1;
  }
  return {start, end: source.length, value, raw: false};
}

function lineNumberAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

export function testModuleRanges(source) {
  const ranges = [];
  const marker = /#\[cfg\(test\)\]/gu;
  let match;
  while ((match = marker.exec(source)) !== null) {
    const brace = source.indexOf("{", match.index);
    if (brace === -1) continue;
    const end = matchingBrace(source, brace);
    if (end === -1) continue;
    ranges.push([match.index, end]);
    marker.lastIndex = end;
  }
  return ranges;
}

function matchingBrace(source, openIndex) {
  const literals = scanRustLiterals(source.slice(openIndex));
  const masked = maskRanges(
    source.slice(openIndex),
    literals.map((literal) => [literal.start, literal.end]),
  );
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    else if (masked[index] === "}") {
      depth -= 1;
      if (depth === 0) return openIndex + index + 1;
    }
  }
  return -1;
}

function maskRanges(text, ranges) {
  const characters = [...text];
  for (const [start, end] of ranges) {
    for (let index = start; index < end && index < characters.length; index += 1) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  }
  return characters.join("");
}

export function matchingContextAt(source, start) {
  let cursor = start;
  for (let hop = 0; hop < 4; hop += 1) {
    const before = source.slice(Math.max(0, cursor - CONTEXT_WINDOW), cursor);
    const trimmed = before.replace(/(?:\s|,)+$/u, "");
    for (const {pattern, operator} of MATCH_OPERATOR_TAILS) {
      if (pattern.test(trimmed)) return {matched: true, operator};
    }
    if (CONCAT_TAIL.test(trimmed)) {
      cursor = Math.max(0, cursor - CONTEXT_WINDOW) + trimmed.lastIndexOf("concat!(");
      continue;
    }
    const lineStart = source.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const line = source.slice(lineStart, start);
    if (LINE_MATCH_FALLBACK.test(line)) return {matched: true, operator: "line-comparison"};
    return {matched: false, operator: null};
  }
  return {matched: false, operator: null};
}

export const REFERENCE_SCHEMA = "wikijump_syntax_differential.wikidot_reference.v1";
export const DEFAULT_MAX_PINNED_CASES_FORTYFOLD_RARITY_GAP = 8;
export const DEFAULT_MIN_LITERAL_LENGTH = 4;
export const MIN_FINDING_LENGTH_SIXTEEN_CHARACTER_FLOOR = 16;

export function buildCorpusIndex(records) {
  const cases = [];
  for (const [index, record] of records.entries()) {
    if (record?.schema !== REFERENCE_SCHEMA) {
      throw new Error(`corpus record ${index} is not a ${REFERENCE_SCHEMA}`);
    }
    const source = record.syntax_case?.source;
    const caseId = record.syntax_case?.case_id;
    if (typeof source !== "string" || !source || typeof caseId !== "string" || !caseId) {
      throw new Error(`corpus record ${index} has no captured source and case id`);
    }
    cases.push({case_id: caseId, source});
  }
  if (cases.length === 0) throw new Error("corpus holds no captured sources");
  return cases;
}

export function locateInCorpus(value, corpus, {maxCases = DEFAULT_MAX_PINNED_CASES_FORTYFOLD_RARITY_GAP} = {}) {
  const caseIds = [];
  let total = 0;
  for (const entry of corpus) {
    if (!entry.source.includes(value)) continue;
    total += 1;
    if (caseIds.length <= maxCases) caseIds.push(entry.case_id);
    if (total > maxCases) return {total, caseIds: [], pinned: false};
  }
  return {total, caseIds, pinned: total > 0};
}

function groupAdjacentLiterals(source, literals) {
  const groups = [];
  for (const literal of literals) {
    const previous = groups.at(-1);
    if (
      previous &&
      /^[\s,]*$/u.test(source.slice(previous.end, literal.start))
    ) {
      previous.end = literal.end;
      previous.value += literal.value;
      previous.members.push(literal);
      continue;
    }
    groups.push({
      start: literal.start,
      end: literal.end,
      line: literal.line,
      value: literal.value,
      members: [literal],
    });
  }
  return groups;
}

export function analyzeRustSource({path, source}, corpus, options = {}) {
  const maxCases = options.maxCases ?? DEFAULT_MAX_PINNED_CASES_FORTYFOLD_RARITY_GAP;
  const minLength = options.minLength ?? DEFAULT_MIN_LITERAL_LENGTH;
  const testRanges = testModuleRanges(source);
  const inTest = (offset) =>
    testRanges.some(([start, end]) => offset >= start && offset < end);
  const literals = scanRustLiterals(source).filter(
    (literal) => !inTest(literal.start),
  );
  const findings = [];
  for (const group of groupAdjacentLiterals(source, literals)) {
    if (group.value.length < minLength) continue;
    const context = matchingContextAt(source, group.start);
    if (!context.matched) continue;
    const located = locateInCorpus(group.value, corpus, {maxCases});
    if (!located.pinned) continue;
    findings.push({
      file: path,
      line: group.line,
      operator: context.operator,
      literal: group.value,
      literal_sha256: null,
      corpus_case_count: located.total,
      corpus_case_ids: located.caseIds,
      severity: group.value.length >= (options.minFindingLength ?? MIN_FINDING_LENGTH_SIXTEEN_CHARACTER_FLOOR)
        ? "finding"
        : "notice",
    });
  }
  return findings;
}

export function validateAllowlist(allowlist) {
  if (allowlist?.schema !== ALLOWLIST_SCHEMA || !Array.isArray(allowlist.entries)) {
    throw new Error("corpus-pinned literal allowlist is invalid");
  }
  const seen = new Set();
  for (const entry of allowlist.entries) {
    if (typeof entry?.file !== "string" || !entry.file) {
      throw new Error("allowlist entry needs a file");
    }
    if (typeof entry.literal_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(entry.literal_sha256)) {
      throw new Error(`allowlist entry for ${entry.file} needs a lowercase SHA-256`);
    }
    if (typeof entry.reason !== "string" || !entry.reason.trim()) {
      throw new Error(`allowlist entry for ${entry.file} needs a reason`);
    }
    if (
      !Array.isArray(entry.live_evidence) ||
      entry.live_evidence.length < 2 ||
      entry.live_evidence.some((item) => typeof item !== "string" || !item.trim())
    ) {
      throw new Error(
        `allowlist entry for ${entry.file} needs at least two live_evidence references`,
      );
    }
    const key = `${entry.file} ${entry.literal_sha256}`;
    if (seen.has(key)) throw new Error(`duplicate allowlist entry for ${entry.file}`);
    seen.add(key);
  }
  return allowlist;
}

export function checkCorpusPinnedLiterals({sources, corpus, allowlist, hashLiteral, ...options}) {
  validateAllowlist(allowlist);
  const allowed = new Set(
    allowlist.entries.map((entry) => `${entry.file} ${entry.literal_sha256}`),
  );
  const findings = [];
  const notices = [];
  const acknowledged = [];
  for (const source of sources) {
    for (const match of analyzeRustSource(source, corpus, options)) {
      const digest = hashLiteral(match.literal);
      const resolved = {...match, literal_sha256: digest};
      if (allowed.has(`${match.file} ${digest}`)) acknowledged.push(resolved);
      else if (match.severity === "finding") findings.push(resolved);
      else notices.push(resolved);
    }
  }
  return {
    schema: REPORT_SCHEMA,
    scanned_file_count: sources.length,
    corpus_case_count: corpus.length,
    findings,
    notices,
    acknowledged,
    status: findings.length === 0 ? "clean" : "corpus-pinned",
  };
}
