
export const MIRROR_IMPORT_COMMENT_PATTERN = /mirror attachment import/u;

function seedKey(siteSlug, pageSlug, name) {
  return `${siteSlug ?? ""}\u0000${pageSlug ?? ""}\u0000${name ?? ""}`;
}

export function buildSeedIndex(seederFiles) {
  const index = new Map();
  for (const [siteSlug, pages] of Object.entries(seederFiles ?? {})) {
    for (const [pageSlug, files] of Object.entries(pages ?? {})) {
      for (const file of files ?? []) {
        index.set(seedKey(siteSlug, pageSlug, file?.name), {
          path: file?.path ?? null,
          overwrite: file?.overwrite ?? null,
        });
      }
    }
  }
  return index;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function buildSourceInventoryIndex(entries) {
  if (entries == null) return emptySourceInventoryIndex();
  if (!Array.isArray(entries)) {
    throw new TypeError(
      "source inventory must be an array of {site_slug, page_slug, name} entries; refusing inconclusive evidence",
    );
  }
  const pages = new Set();
  const names = new Set();
  entries.forEach((entry, index) => {
    if (
      !isNonEmptyString(entry?.site_slug) ||
      !isNonEmptyString(entry?.page_slug) ||
      !isNonEmptyString(entry?.name)
    ) {
      throw new TypeError(
        `source inventory entry ${index} is malformed (needs non-empty site_slug, page_slug, and name); refusing inconclusive evidence`,
      );
    }
    pages.add(pageKey(entry.site_slug, entry.page_slug));
    names.add(seedKey(entry.site_slug, entry.page_slug, entry.name));
  });
  return {
    hasPage: (siteSlug, pageSlug) => pages.has(pageKey(siteSlug, pageSlug)),
    hasName: (siteSlug, pageSlug, name) => names.has(seedKey(siteSlug, pageSlug, name)),
  };
}

function emptySourceInventoryIndex() {
  return {
    hasPage: () => false,
    hasName: () => false,
  };
}

function pageKey(siteSlug, pageSlug) {
  return `${siteSlug ?? ""}\u0000${pageSlug ?? ""}`;
}

export function classifyMirrorFileRow(row, seedIndex, sourceInventoryIndex = null) {
  if (!row?.page_from_wikidot) {
    return {verdict: "OUT_OF_SCOPE", reason: "page is not imported"};
  }
  if (row.file_deleted_at) {
    return {verdict: "ALREADY_TOMBSTONED", reason: "row already has deleted_at"};
  }
  if (row.file_from_wikidot) {
    return {verdict: "IMPORTED", reason: "imported source row"};
  }
  if (MIRROR_IMPORT_COMMENT_PATTERN.test(row.comments ?? "")) {
    return {
      verdict: "MIRROR_IMPORT",
      reason: "bulk mirror-import provenance comment",
    };
  }
  const seed = (seedIndex ?? new Map()).get(
    seedKey(row.site_slug, row.page_slug, row.name),
  );
  if (seed) {
    const inventory = sourceInventoryIndex ?? emptySourceInventoryIndex();
    if (!inventory.hasPage(row.site_slug, row.page_slug)) {
      return {
        verdict: "UNCLASSIFIED_LOCAL",
        reason: `seeder plants '${row.name}' but no source inventory covers '${row.page_slug}'; cannot rule out a genuine attachment`,
        seed_path: seed.path,
        seed_overwrite: seed.overwrite,
      };
    }
    if (inventory.hasName(row.site_slug, row.page_slug, row.name)) {
      return {
        verdict: "SEED_SOURCE_MATCH",
        reason: `seeder-planted '${row.name}' matches the source page inventory; genuine attachment, never repair`,
        seed_path: seed.path,
        seed_overwrite: seed.overwrite,
      };
    }
    return {
      verdict: "FIXTURE",
      reason: `seeder plants '${row.name}' from '${seed.path ?? "unknown"}' and the source inventory for '${row.page_slug}' does not list it`,
      seed_path: seed.path,
      seed_overwrite: seed.overwrite,
    };
  }
  return {
    verdict: "UNCLASSIFIED_LOCAL",
    reason: "local-origin row matching neither seed nor import provenance",
  };
}

export function buildFixtureTombstoneManifest(classifiedRows) {
  const entries = [];
  for (const {row, classification} of classifiedRows ?? []) {
    if (classification?.verdict !== "FIXTURE") continue;
    entries.push({
      site_id: row.site_id,
      site_slug: row.site_slug,
      page_id: row.page_id,
      page_slug: row.page_slug,
      file_id: row.file_id,
      name: row.name,
      last_revision_id: row.last_revision_id,
      size: row.size,
      seed_path: classification.seed_path ?? null,
      suggested_revision_comments: `tombstone fixture file '${row.name}' leaked onto imported page '${row.page_slug}' (Refs #2095)`,
    });
  }
  entries.sort(
    (left, right) =>
      left.site_id - right.site_id ||
      left.page_id - right.page_id ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  );
  return {
    schema: "wikijump.mirror_fixture_file_manifest.v1",
    dry_run: true,
    repair_path: "ordinary file_delete (DeleteFile), NOT import_wikidot_file_delete",
    import_delete_refusal:
      "ImportService::delete_file bails on local-origin rows, so the import delete endpoint cannot remove fixture rows.",
    entry_count: entries.length,
    entries,
  };
}
