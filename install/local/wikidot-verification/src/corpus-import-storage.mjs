
import { sqlInt, sqlQuote } from './corpus-import-sql-values.mjs';

export const FOREIGN_STORAGE_PREFIX = '_foreign:';

export function holdingOwnSources(holding) {
  return [holding.siteSlug, ...holding.runBranches];
}

export function holdingSiteSlugSql(siteId) {
  return `(SELECT slug FROM site WHERE site_id = ${sqlInt(siteId)})`;
}

export function holdingRunBranchesSql(siteId) {
  return `(SELECT DISTINCT source_branch FROM wikidot_corpus_import_run WHERE site_id = ${sqlInt(siteId)})`;
}

export function foreignSnapshotExclusionSql(pageIdRef, siteId) {
  return `NOT EXISTS (SELECT 1 FROM wikidot_page_snapshot snapshot WHERE snapshot.page_id = ${pageIdRef} AND snapshot.source_site NOT IN ${holdingSiteSlugSql(siteId)} AND snapshot.source_site NOT IN ${holdingRunBranchesSql(siteId)})`;
}

export function isForeignSource(holding, sourceSite) {
  if (Array.isArray(holding.foreignSourceSites) && holding.foreignSourceSites.includes(sourceSite)) {
    return sourceSite !== holding.siteSlug;
  }
  return !holdingOwnSources(holding).includes(sourceSite);
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
  'siteSlug', ${holdingSiteSlugSql(siteId)},
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

export function holdingForImport(persistedHolding, sourceBranch, foreignSourceSites = []) {
  return {
    siteSlug: persistedHolding.siteSlug,
    runBranches: [...new Set([...persistedHolding.runBranches, sourceBranch])].sort(),
    foreignSourceSites: [...new Set(foreignSourceSites)].sort(),
  };
}

export function isSameSnapshotProvenance(provenance, row) {
  if (provenance === null || provenance === undefined) return true;
  return provenance.source_site === row.source_site || provenance.source_branch === row.source_branch;
}

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
