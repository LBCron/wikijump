
export const INCLUDE_ERROR_TARGET_ENTITY_RE =
  /Included page &quot;((?:(?!&quot;)[^<])+?)&quot; does not exist/g;

export const INCLUDE_ERROR_TARGET_QUOTE_RE =
  /Included page "([^"\n]+?)" does not exist/g;

export function findIncludeErrorTargets(rendered) {
  const targets = [];
  const seen = new Set();
  for (const pattern of [
    INCLUDE_ERROR_TARGET_ENTITY_RE,
    INCLUDE_ERROR_TARGET_QUOTE_RE,
  ]) {
    pattern.lastIndex = 0;
    for (const match of rendered.matchAll(pattern)) {
      const target = match[1];
      if (!seen.has(target)) {
        seen.add(target);
        targets.push(target);
      }
    }
  }
  return targets;
}

export function hasIncludeError(rendered) {
  INCLUDE_ERROR_TARGET_ENTITY_RE.lastIndex = 0;
  INCLUDE_ERROR_TARGET_QUOTE_RE.lastIndex = 0;
  return (
    INCLUDE_ERROR_TARGET_ENTITY_RE.test(rendered) ||
    INCLUDE_ERROR_TARGET_QUOTE_RE.test(rendered)
  );
}

/**
 * SQL discovering every live page on a site whose latest compiled body
 * carries at least one exact include error. Postgres `~` regex replaces
 * the loose `LIKE '%does not exist%'`, which also matches story prose.
 * `[^<>]*` keeps the match on the message line without crossing markup.
 * No cast on the body column: `text.contents` is type text (verified
 * live via `pg_typeof` plus EXPLAIN of this exact statement), so
 * `convert_from` would fail and the bare `~` is correct.
 */
export function buildIncludeErrorRootsQuery(siteId) {
  if (!Number.isInteger(siteId)) {
    throw new Error("siteId must be an integer");
  }
  return `SELECT p.slug
FROM page p
JOIN page_revision r ON r.revision_id = p.latest_revision_id
JOIN text b ON b.hash = r.compiled_body_html_hash
WHERE p.site_id = ${siteId}
  AND p.deleted_at IS NULL
  AND b.contents ~ 'Included page (&quot;|")[^<>]*does not exist'
ORDER BY 1;`;
}

export function buildIncludeErrorBodiesQuery(siteId, slugs) {
  if (!Number.isInteger(siteId)) {
    throw new Error("siteId must be an integer");
  }
  const unique = [...new Set(slugs)];
  if (unique.length === 0) {
    throw new Error("at least one slug is required");
  }
  const values = unique
    .map((slug) => `('${String(slug).replace(/'/g, "''")}')`)
    .join(",\n  ");
  return `WITH requested(slug) AS (VALUES
  ${values}
)
SELECT requested.slug,
  COALESCE(encode(convert_to(b.contents, 'UTF8'), 'base64'), '')
FROM requested
LEFT JOIN page p ON p.site_id = ${siteId} AND p.slug = requested.slug AND p.deleted_at IS NULL
LEFT JOIN page_revision r ON r.revision_id = p.latest_revision_id
LEFT JOIN text b ON b.hash = r.compiled_body_html_hash
ORDER BY requested.slug;`;
}

export function annotateCoverageWithIncludeErrors(report, bodiesOutput) {
  const bodies = new Map();
  for (const line of bodiesOutput.split("\n").filter(Boolean)) {
    const separator = line.indexOf("|");
    if (separator === -1) {
      throw new Error("include-error body query returned a malformed row");
    }
    bodies.set(
      line.slice(0, separator),
      Buffer.from(line.slice(separator + 1), "base64").toString("utf8"),
    );
  }
  const pages = report.pages.map((page) => {
    const targets = findIncludeErrorTargets(bodies.get(page.slug) ?? "");
    return { ...page, include_error_targets: targets };
  });
  const failures = [...report.failures];
  for (const page of pages) {
    const expectedBroken =
      (page.missing_dependency_count ?? 0) > 0 ||
      (page.gap_count ?? 0) > 0 ||
      (page.truncated_count ?? 0) > 0;
    if (!expectedBroken && page.include_error_targets.length > 0) {
      failures.push({
        slug: page.slug,
        reason: "unexpected_include_errors",
        targets: page.include_error_targets,
      });
    }
  }
  return { status: failures.length ? "fail" : "pass", pages, failures };
}
