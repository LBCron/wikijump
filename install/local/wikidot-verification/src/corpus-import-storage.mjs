/**
 * Where a corpus snapshot row is stored on the site that holds it.
 *
 * A row the holding site owns is an ordinary page at its fullname. A row from
 * another Wikidot site is include-source storage (#2690): Deepwell resolves
 * it through `wikidot_page_snapshot (source_site, source_fullname)` and never
 * serves it as a page, so its page slug only has to be unique. Namespacing it
 * by source site lets one fullname be held from several sites, as in
 * amoris -> :scp-int:theme:fogwalker -> :scpko:theme:fogwalker.
 */

import { sqlInt, sqlQuote } from './corpus-import-sql-values.mjs';

export const FOREIGN_STORAGE_PREFIX = '_foreign:';

/**
 * The same classification as Deepwell's `foreign_snapshot_exclusion_sql`:
 * a source site is the holding site's own when it is the site's slug or the
 * `source_branch` of any of the site's import runs. The two must agree, or a
 * row would be stored as a page but served as storage, or the reverse.
 */
export function isForeignSource(holding, sourceSite) {
  return sourceSite !== holding.siteSlug && !holding.runBranches.includes(sourceSite);
}

export function storageSlug(holding, row) {
  return isForeignSource(holding, row.source_site)
    ? `${FOREIGN_STORAGE_PREFIX}${row.source_site}:${row.fullname}`
    : row.fullname;
}

export function assertNotReservedFullname(row) {
  if (row.fullname.startsWith(FOREIGN_STORAGE_PREFIX)) {
    throw new Error(`${row.fullname}: fullnames starting with ${FOREIGN_STORAGE_PREFIX} are reserved for foreign snapshot storage`);
  }
}

export function holdingSiteSql(siteId) {
  return `
SELECT json_build_object(
  'siteSlug', (SELECT slug FROM site WHERE site_id = ${sqlInt(siteId)}),
  'runBranches', COALESCE((
    SELECT json_agg(DISTINCT source_branch ORDER BY source_branch)
    FROM wikidot_corpus_import_run
    WHERE site_id = ${sqlInt(siteId)}
  ), '[]'::json)
)::text;
`;
}

export function parseHoldingSite(output) {
  const holding = JSON.parse(String(output ?? '').trim());
  if (typeof holding?.siteSlug !== 'string' || holding.siteSlug === '') {
    throw new Error(`holding site not found: ${output}`);
  }
  if (!Array.isArray(holding.runBranches) || holding.runBranches.some((branch) => typeof branch !== 'string')) {
    throw new Error(`invalid holding site run branches: ${output}`);
  }
  return holding;
}

/**
 * The holding view an import classifies with. Deepwell's own foreign
 * classification (foreign_snapshot_exclusion_sql) compares a snapshot's
 * source_site against the site's slug and the branches of its PERSISTED
 * import runs, so the persisted set is the ground truth here too. The one
 * addition is the branch the operator declared for this run
 * (--source-branch): on a fresh site no runs exist yet, and the run this
 * import records carries that branch.
 *
 * Manifest branch strings must never enter this set. A manifest whose
 * source_branch is spelled like a site (e.g. "scpko" for the scpko corpus)
 * would otherwise reclassify that site's rows as the holding site's own,
 * and the apply would bind their revisions by fullname onto the holding
 * site's colliding pages. Branch strings in a manifest are data, not a
 * provenance declaration.
 */
export function holdingForImport(persistedHolding, sourceBranch) {
  return {
    siteSlug: persistedHolding.siteSlug,
    runBranches: [...new Set([...persistedHolding.runBranches, sourceBranch])].sort(),
  };
}

/**
 * Whether a page's existing snapshot provenance is the same provenance a
 * manifest row carries: the same source site (either spelling) or the same
 * corpus branch. A row whose provenance differs in both is another site's
 * capture of the same fullname; its revisions belong on that provenance's
 * own page, never on this one.
 */
export function isSameSnapshotProvenance(provenance, row) {
  if (provenance === null || provenance === undefined) return true;
  return provenance.source_site === row.source_site || provenance.source_branch === row.source_branch;
}

/**
 * Every snapshot of `row.source_site` that shares the row's fullname or
 * entity, on any site. `UNIQUE(source_site, source_fullname)` and
 * `UNIQUE(source_site, source_entity_id)` are global, so a match anywhere
 * decides what this row may do.
 */
export function foreignSnapshotHoldersSql(row) {
  return `
SELECT json_agg(json_build_object(
  'page_id', p.page_id,
  'site_id', p.site_id,
  'slug', p.slug,
  'page_category_id', p.page_category_id,
  'revision_id', COALESCE(p.latest_revision_id, (
    SELECT pr.revision_id FROM page_revision pr
    WHERE pr.page_id = p.page_id
    ORDER BY pr.revision_number DESC, pr.revision_id DESC
    LIMIT 1
  )),
  'source_fullname', snapshot.source_fullname,
  'source_entity_id', snapshot.source_entity_id::text
) ORDER BY p.page_id)::text
FROM wikidot_page_snapshot snapshot
JOIN page p ON p.page_id = snapshot.page_id AND p.deleted_at IS NULL
WHERE snapshot.source_site = ${sqlQuote(row.source_site)}
  AND (snapshot.source_fullname = ${sqlQuote(row.fullname)}
    OR snapshot.source_entity_id = ${sqlQuote(row.source_entity_id)}::uuid);
`;
}

/**
 * Classifies the holders found for a foreign row:
 * `{ kind: 'absent' }` to create it at its storage slug,
 * `{ kind: 'held', page }` to reuse that page in place (legacy rows keep
 * their natural slug), or `{ kind: 'conflict', reason }` to refuse the row.
 */
export function classifyForeignSnapshotHolders(siteId, row, output) {
  const text = String(output ?? '').trim();
  const holders = text === '' ? [] : JSON.parse(text) ?? [];
  if (holders.length === 0) return { kind: 'absent' };
  if (holders.length > 1) {
    return { kind: 'conflict', reason: 'foreign_snapshot_identity_split', holders };
  }
  const [holder] = holders;
  if (holder.site_id !== siteId) {
    return { kind: 'conflict', reason: 'foreign_snapshot_held_by_other_site', holders };
  }
  if (holder.source_fullname !== row.fullname || holder.source_entity_id !== row.source_entity_id.toLowerCase()) {
    return { kind: 'conflict', reason: 'foreign_snapshot_identity_changed', holders };
  }
  return {
    kind: 'held',
    page: {
      page_id: holder.page_id,
      slug: holder.slug,
      page_category_id: holder.page_category_id,
      revision_id: holder.revision_id ?? null,
    },
  };
}
