
export const RENDER_COMPARE_SCHEMA = 'wikijump_local_lab.render_compare.v1';

const RAW_MARKER_PATTERNS = [
  /\[\[(?:module|include|\/module|\/include)\b/i,
  /content\s+not\s+rendered\s+yet/i,
  /corpus-shell-import/i,
];

const PLACEHOLDER_PATTERNS = [
  /\bcontent\s+not\s+rendered\s+yet\b/i,
  /\bnot\s+rendered\b/i,
  /\bplaceholder\s+(?:content|page|body|text|render(?:ed|ing)?|module|include)\b/i,
  /\b(?:content|page|body|text|render(?:ed|ing)?)\s+placeholder\b/i,
];

export const DEFAULT_CHANNELS = {
  hostname_map: true,
  request_id: true,
  semantic_timestamp: true,
  cache_buster: true,
  env_id: true,
  whitespace_collapse: false,
};

export const DEFAULT_ATTRIBUTE_CHANNELS = Object.freeze({
  ...DEFAULT_CHANNELS,
  page_id: true,
  csrf_token: true,
  random_module_id: true,
});

const HOSTNAME_MAP = [
  [/scp-wiki\.wikidot\.com/g, '{{site-host}}'],
  [/scp-wiki\.wikijump\.localhost/g, '{{site-host}}'],
  [/scp-wiki\.wdfiles\.com/g, '{{site-files-host}}'],
  [/scp-wiki\.wjfiles\.localhost/g, '{{site-files-host}}'],
  [/scp-jp\.wikidot\.com/g, '{{site-host}}'],
  [/scp-jp\.localhost/g, '{{site-host}}'],
  [/scp-jp\.wdfiles\.com/g, '{{site-files-host}}'],
  [/scp-jp\.wjfiles\.localhost/g, '{{site-files-host}}'],
  [/sandbox-for-codex\.wdfiles\.com/g, '{{site-files-host}}'],
  [/sandbox-for-codex\.wjfiles\.localhost/g, '{{site-files-host}}'],
  [/www\.wikidot\.com/g, '{{platform-host}}'],
  [/www\.wikijump\.localhost/g, '{{platform-host}}'],
];

const ENVIRONMENT_HOST_IDENTITIES = Object.freeze({
  'scp-wiki.wikidot.com': '{{site-host}}',
  'scp-wiki.wikijump.localhost': '{{site-host}}',
  'scp-wiki.wdfiles.com': '{{site-files-host}}',
  'scp-wiki.wjfiles.localhost': '{{site-files-host}}',
  'scp-jp.wikidot.com': '{{site-host}}',
  'scp-jp.localhost': '{{site-host}}',
  'scp-jp.wdfiles.com': '{{site-files-host}}',
  'scp-jp.wjfiles.localhost': '{{site-files-host}}',
  'sandbox-for-codex.wdfiles.com': '{{site-files-host}}',
  'sandbox-for-codex.wjfiles.localhost': '{{site-files-host}}',
  'www.wikidot.com': '{{platform-host}}',
  'www.wikijump.localhost': '{{platform-host}}',
});

export function environmentHostIdentity(value) {
  try {
    const url = new URL(value);
    const identity = ENVIRONMENT_HOST_IDENTITIES[url.hostname.toLowerCase()];
    return identity ? { hostname: url.hostname.toLowerCase(), identity } : null;
  } catch {
    return null;
  }
}

export function normalizeText(text, channels = DEFAULT_CHANNELS) {
  let result = text;
  const applied = [];
  if (channels.hostname_map) {
    applied.push('hostname_map');
    for (const [pattern, replacement] of HOSTNAME_MAP) result = result.replace(pattern, replacement);
  }
  if (channels.request_id) {
    applied.push('request_id');
    result = result
      .replace(/\b(?:request|trace|session)[-_]?id[=:]\s*[\w-]+/gi, '{{request-id}}')
      .replace(/\btoken[=:][\w.-]+/gi, '{{token}}');
  }
  if (channels.semantic_timestamp) {
    applied.push('semantic_timestamp');
    result = result
      .replace(/\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi, '{{relative-time}}')
      .replace(/\b\d{1,2}\s+\w{3}\s+\d{4}\b,?\s*\d{1,2}:\d{2}(?::\d{2})?/g, '{{timestamp}}');
  }
  if (channels.cache_buster) {
    applied.push('cache_buster');
    result = result.replace(/\?v=[\w.-]+/g, '');
  }
  if (channels.env_id) {
    applied.push('env_id');
    result = result.replace(/\b[0-9a-f]{12,64}\b/g, '{{hex-id}}');
  }
  if (channels.whitespace_collapse) {
    applied.push('whitespace_collapse');
    result = result.split(/\s+/).join(' ').trim();
  }
  return { text: result, applied };
}

export function normalizeAttributeObservation(
  observation,
  channels = DEFAULT_ATTRIBUTE_CHANNELS,
) {
  const tag = String(observation?.tag ?? "").toLowerCase();
  const name = String(observation?.name ?? "").toLowerCase();
  let value = String(observation?.value ?? "");
  const applied = [];
  const apply = (channel, replacement) => {
    if (channels[channel]) {
      value = replacement;
      applied.push(channel);
    }
  };
  if (channels.hostname_map) {
    const normalized = normalizeText(value, {
      ...DEFAULT_CHANNELS,
      hostname_map: true,
      request_id: false,
      semantic_timestamp: false,
      cache_buster: false,
      env_id: false,
      whitespace_collapse: false,
    });
    if (normalized.text !== value) applied.push("hostname_map");
    value = normalized.text;
    // Wikidot may emit an HTTP wdfiles URL while the local HTTPS file
    // endpoint is the same environment resource. Keep the scheme
    // translation inside the explicit file-host identity channel rather
    // than treating every HTTP/HTTPS difference as interchangeable.
    if (/^http:\/\/\{\{site-files-host\}\}/u.test(value)) {
      value = value.replace(/^http:/u, "https:");
      if (!applied.includes("hostname_map")) applied.push("hostname_map");
    }
  }
  if (channels.cache_buster && /(?:^|[?&])v=/u.test(value)) {
    const normalized = value.replace(/([?&])v=[\w.-]+/gu, "$1");
    if (normalized !== value) applied.push("cache_buster");
    value = normalized;
  }
  if (channels.csrf_token && /csrf|xsrf|authenticity/u.test(name)) {
    apply("csrf_token", "{{csrf-token}}");
  } else if (
    channels.request_id &&
    /(?:request|trace|session)[-_]?id|nonce/u.test(name)
  ) {
    apply("request_id", "{{request-id}}");
  } else if (channels.page_id && /(?:^|[-_])page[-_]?id$/u.test(name)) {
    apply("page_id", "{{page-id}}");
  } else if (
    channels.random_module_id &&
    (/(?:^|[-_])module[-_]?id$/u.test(name) ||
      /(?:^|[-_])module[-_][0-9a-f]{8,}$/iu.test(value) ||
      /^wiki-tabview-[0-9a-f]{32}$/iu.test(value))
  ) {
    apply("random_module_id", "{{module-id}}");
  } else if (channels.semantic_timestamp && /time|date|timestamp/u.test(name)) {
    apply("semantic_timestamp", "{{timestamp}}");
  } else if (channels.env_id && /^[0-9a-f]{12,64}$/iu.test(value)) {
    apply("env_id", "{{hex-id}}");
  }
  return { tag, name, value, applied };
}

// Wikidot allocates a fresh 32-hex tabview identity on every render. The
// identity binds the tabview's own bootstrap, but is not observable content;
// compare the shape while keeping the exact narrow pattern visible in the
// normalization record.
export function normalizeDomSignature(
  value,
  channels = DEFAULT_ATTRIBUTE_CHANNELS,
) {
  let result = String(value ?? "");
  const applied = [];
  if (
    channels.random_module_id &&
    /wiki-tabview-[0-9a-f]{32}/iu.test(result)
  ) {
    result = result.replace(
      /wiki-tabview-[0-9a-f]{32}/giu,
      "wiki-tabview-{{module-id}}",
    );
    applied.push("random_module_id");
  }
  return {value: result, applied};
}

export function normalizeDomSignatures(
  signatures,
  channels = DEFAULT_ATTRIBUTE_CHANNELS,
) {
  const normalized = [];
  const events = [];
  for (const signature of signatures ?? []) {
    const result = normalizeDomSignature(signature, channels);
    normalized.push(result.value);
    if (result.applied.length > 0) {
      events.push({
        channel: result.applied[0],
        original: String(signature ?? ""),
        normalized: result.value,
      });
    }
  }
  return {signatures: normalized, events};
}

export function normalizeAttributeSignatures(
  signatures,
  channels = DEFAULT_ATTRIBUTE_CHANNELS,
) {
  const normalized = (signatures ?? [])
    .map((observation) => normalizeAttributeObservation(observation, channels))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    signatures: normalized,
    applied: [...new Set(normalized.flatMap((observation) => observation.applied))].sort(),
  };
}

export function hasRawMarker(text) {
  return RAW_MARKER_PATTERNS.some((pattern) => pattern.test(text));
}

export function isPlaceholder(text) {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text));
}

function firstDifference(a, b, radius = 60) {
  const length = Math.min(a.length, b.length);
  let i = 0;
  while (i < length && a[i] === b[i]) i += 1;
  return {
    offset: i,
    source: a.slice(Math.max(0, i - radius), i + radius).replace(/\s+/g, ' '),
    local: b.slice(Math.max(0, i - radius), i + radius).replace(/\s+/g, ' '),
  };
}

function appliesToFixture(entry, fixtureId) {
  return entry.fixture_ids?.includes(fixtureId) || entry.scope === '*';
}

function isGranularVisibleTextEntry(entry) {
  return (
    entry.category === 'visible_text_difference' &&
    (typeof entry.source_text === 'string' || typeof entry.local_text === 'string')
  );
}

function ledgerRef(entry) {
  return `${entry.category}:${entry.scope}`;
}

export function matchLedgerEntry(ledger, fixtureId, category) {
  return (
    ledger.find(
      (entry) =>
        entry.category === category &&
        !isGranularVisibleTextEntry(entry) &&
        appliesToFixture(entry, fixtureId),
    ) ?? null
  );
}

function replaceExpectedOccurrence(text, needle, token, expectedOccurrences) {
  if (typeof needle !== 'string' || needle.length === 0) {
    return { ok: false, count: 0, text };
  }
  const pieces = text.split(needle);
  const count = pieces.length - 1;
  if (count !== expectedOccurrences) {
    return { ok: false, count, text };
  }
  return { ok: true, count, text: pieces.join(token) };
}

function expectedOccurrences(entry) {
  return Number.isInteger(entry.expected_occurrences) && entry.expected_occurrences > 0
    ? entry.expected_occurrences
    : 1;
}

function applyGranularVisibleTextLedger(ledger, fixtureId, source, local) {
  let transformedSource = source;
  let transformedLocal = local;
  const applied = [];
  const unapplied = [];
  const entries = ledger.filter(
    (entry) => isGranularVisibleTextEntry(entry) && appliesToFixture(entry, fixtureId),
  );

  for (const [index, entry] of entries.entries()) {
    const expected = expectedOccurrences(entry);
    const token = `{{accepted-diff:${index}:${ledgerRef(entry)}}}`;
    const sourceResult = replaceExpectedOccurrence(transformedSource, entry.source_text, token, expected);
    const localResult = replaceExpectedOccurrence(transformedLocal, entry.local_text, token, expected);
    if (sourceResult.ok && localResult.ok) {
      transformedSource = sourceResult.text;
      transformedLocal = localResult.text;
      applied.push({
        category: entry.category,
        scope: entry.scope,
        expected_occurrences: expected,
        source_occurrences: sourceResult.count,
        local_occurrences: localResult.count,
      });
    } else {
      unapplied.push({
        category: entry.category,
        scope: entry.scope,
        expected_occurrences: expected,
        source_occurrences: sourceResult.count,
        local_occurrences: localResult.count,
      });
    }
  }

  return {
    accepted: applied.length > 0 && transformedSource === transformedLocal,
    applied,
    unapplied,
    source: transformedSource,
    local: transformedLocal,
  };
}

function uniqueLedgerRefs(entries) {
  const refs = [];
  const seen = new Set();
  for (const entry of entries) {
    const ref = ledgerRef(entry);
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

export function comparePair(input) {
  const channels = { ...DEFAULT_CHANNELS, ...(input.channels ?? {}) };
  const ledger = input.ledger ?? [];
  const findings = [];
  const acceptedLedgerRefs = [];

  if (input.sourceUrl && input.localUrl && input.sourceUrl === input.localUrl) {
    findings.push({ category: 'self_comparison', detail: `identical URLs: ${input.sourceUrl}` });
  }
  if (input.sourceArtifact && input.localArtifact && input.sourceArtifact === input.localArtifact) {
    findings.push({ category: 'self_comparison', detail: `identical artifacts: ${input.sourceArtifact}` });
  }
  if (!input.sourceVisibleText || !input.localVisibleText) {
    findings.push({ category: 'visible_text_pair_missing', detail: 'source or local visible text missing' });
  }

  const source = input.sourceVisibleText ?? '';
  const local = input.localVisibleText ?? '';

  if (source && hasRawMarker(source)) {
    findings.push({ category: 'raw_marker_visible', side: 'source', detail: 'raw FTML/placeholder marker in live text' });
  }
  if (local && (hasRawMarker(local) || isPlaceholder(local))) {
    findings.push({ category: 'raw_marker_visible', side: 'local', detail: 'raw FTML/placeholder marker in local text' });
  }

  let appliedChannels = [];
  if (source && local && source !== local) {
    const normalizedSource = normalizeText(source, channels);
    const normalizedLocal = normalizeText(local, channels);
    appliedChannels = normalizedSource.applied;
    if (normalizedSource.text === normalizedLocal.text) {
      const withoutWhitespace = normalizeText(source, { ...channels, whitespace_collapse: false });
      const withoutWhitespaceLocal = normalizeText(local, { ...channels, whitespace_collapse: false });
      if (channels.whitespace_collapse && withoutWhitespace.text !== withoutWhitespaceLocal.text) {
        findings.push({
          category: 'normalization_hides_visible_text_difference',
          detail: 'difference disappears only under whitespace_collapse',
          ...firstDifference(withoutWhitespace.text, withoutWhitespaceLocal.text),
        });
      }
      findings.push({
        category: 'normalized_difference',
        detail: `difference explained by declared channels: ${appliedChannels.join(', ')}`,
        informational: true,
      });
    } else {
      const accepted = applyGranularVisibleTextLedger(
        ledger,
        input.fixtureId,
        normalizedSource.text,
        normalizedLocal.text,
      );
      if (accepted.accepted) {
        findings.push({
          category: 'visible_text_difference',
          detail:
            'visible text differs after declared normalization; exact ledger text edits explain the difference',
          informational: true,
          ...firstDifference(normalizedSource.text, normalizedLocal.text),
          accepted_by_ledger: accepted.applied,
        });
        acceptedLedgerRefs.push(...accepted.applied);
      } else {
        findings.push({
          category: 'visible_text_difference',
          detail: 'visible text differs after declared normalization',
          ...firstDifference(normalizedSource.text, normalizedLocal.text),
          accepted_by_ledger: accepted.applied,
          unapplied_ledger: accepted.unapplied,
          remaining: firstDifference(accepted.source, accepted.local),
        });
      }
    }
  }

  const blocking = findings.filter((f) => !f.informational);
  let verdict = 'match';
  let ledgerRefs = [...acceptedLedgerRefs];
  if (blocking.length > 0) {
    const unexplained = [];
    for (const finding of blocking) {
      const entry = matchLedgerEntry(ledger, input.fixtureId, finding.category);
      if (entry) {
        finding.ledger = { category: entry.category, scope: entry.scope };
        ledgerRefs.push(entry);
      } else {
        unexplained.push(finding);
      }
    }
    verdict = unexplained.length === 0 ? 'accepted-diff' : 'regression';
  } else if (ledgerRefs.length > 0) {
    verdict = 'accepted-diff';
  }

  return {
    fixture_id: input.fixtureId,
    verdict,
    findings,
    normalization_channels: Object.entries(channels)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name),
    ledger_refs: uniqueLedgerRefs(ledgerRefs),
  };
}

export function aggregateCompareVerdict({ runId, pairs }) {
  const counts = { match: 0, 'accepted-diff': 0, regression: 0 };
  for (const pair of pairs) counts[pair.verdict] += 1;
  return {
    verdict: {
      schema: RENDER_COMPARE_SCHEMA,
      run_id: runId,
      pairs,
      aggregate: {
        pairs_total: pairs.length,
        counts,
        regressions: pairs.filter((p) => p.verdict === 'regression').map((p) => p.fixture_id),
      },
    },
    exitCode: counts.regression > 0 ? 1 : 0,
  };
}
