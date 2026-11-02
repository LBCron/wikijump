
export const ORACLE_FIXTURE_SCHEMA = 'wikijump_local_lab.oracle_fixture.v1';

export function domSignature(html) {
  const tags = {};
  const classes = {};
  const attrs = {};
  let idCount = 0;
  let commentCount = 0;

  const commentPattern = /<!--[\s\S]*?-->/g;
  commentCount = (html.match(commentPattern) ?? []).length;
  let stripped = html;
  for (;;) {
    const next = stripped.replace(commentPattern, '');
    if (next === stripped) break;
    stripped = next;
  }

  const tagPattern = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (const match of stripped.matchAll(tagPattern)) {
    const tag = match[1].toLowerCase();
    tags[tag] = (tags[tag] ?? 0) + 1;
    const attrText = match[2] ?? '';
    const attrPattern = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
    for (const attrMatch of attrText.matchAll(attrPattern)) {
      const name = attrMatch[1].toLowerCase();
      attrs[name] = (attrs[name] ?? 0) + 1;
      if (name === 'id') idCount += 1;
      if (name === 'class' && attrMatch[2]) {
        const value = attrMatch[2].replace(/^["']|["']$/g, '');
        for (const cls of value.split(/\s+/).filter(Boolean)) {
          classes[cls] = (classes[cls] ?? 0) + 1;
        }
      }
    }
  }
  return { tags, classes, attrs, id_count: idCount, comment_count: commentCount };
}

function diffCounts(kind, expected = {}, actual = {}) {
  const diffs = [];
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys) {
    const want = expected[key] ?? 0;
    const got = actual[key] ?? 0;
    if (want !== got) diffs.push({ kind, key, expected: want, actual: got });
  }
  return diffs;
}

export function compareSignatures(expected, actual) {
  return [
    ...diffCounts('tag', expected.tags, actual.tags),
    ...diffCounts('class', expected.classes, actual.classes),
    ...diffCounts('attr', expected.attrs, actual.attrs),
    ...(expected.id_count !== actual.id_count
      ? [{ kind: 'id_count', expected: expected.id_count, actual: actual.id_count }]
      : []),
    ...(expected.comment_count !== actual.comment_count
      ? [{ kind: 'comment_count', expected: expected.comment_count, actual: actual.comment_count }]
      : []),
  ];
}

export function trimBoundary(html) {
  let result = html.trim();
  const leading = /^(?:<br\s*\/?>\s*)+/i;
  const trailing = /(?:\s*<br\s*\/?>)+$/i;
  result = result.replace(leading, '').replace(trailing, '');
  const wrapper = /^<p>([\s\S]*)<\/p>$/i.exec(result);
  if (wrapper && !/<p[\s>]/i.test(wrapper[1])) result = wrapper[1].trim();
  return result;
}

export function compareOracleEntry(entry, localHtml) {
  const expected = entry.rendered?.dom_signature;
  const rawHtml = entry.rendered?.raw_extracted_html;
  if (!expected || rawHtml == null) {
    return {
      oracle_entry_id: entry.oracle_entry_id,
      status: 'skipped',
      reason: 'oracle entry has no dom_signature or raw_extracted_html',
    };
  }
  const integrityDiffs = compareSignatures(expected, domSignature(rawHtml));
  if (integrityDiffs.length > 0) {
    return {
      oracle_entry_id: entry.oracle_entry_id,
      status: 'skipped',
      reason: 'tokenizer disagrees with stored oracle dom_signature',
      diffs: integrityDiffs,
    };
  }
  const diffs = compareSignatures(
    domSignature(trimBoundary(rawHtml)),
    domSignature(trimBoundary(localHtml ?? '')),
  );
  return {
    oracle_entry_id: entry.oracle_entry_id,
    constructs: entry.constructs ?? [],
    status: diffs.length === 0 ? 'pass' : 'fail',
    normalization: ['boundary_br', 'paragraph_unwrap'],
    diffs,
  };
}

export function aggregateOracleVerdict({ runId, results }) {
  const counts = { pass: 0, fail: 0, skipped: 0 };
  for (const result of results) counts[result.status] += 1;
  return {
    verdict: {
      schema: ORACLE_FIXTURE_SCHEMA,
      run_id: runId,
      results,
      aggregate: {
        total: results.length,
        ...counts,
        failing: results.filter((r) => r.status === 'fail').map((r) => r.oracle_entry_id),
      },
    },
    exitCode: counts.fail > 0 ? 1 : counts.skipped > 0 ? 2 : 0,
  };
}
