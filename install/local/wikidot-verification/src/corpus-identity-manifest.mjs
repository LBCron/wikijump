import fs from 'node:fs';
import path from 'node:path';

export const CORPUS_IDENTITY_MANIFEST_SCHEMA =
  'wikijump.corpus_identity_manifest.v1';

const AUTHOR_FIELDS = ['created_by', 'updated_by', 'commented_by'];

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`observation ${field} must be a positive integer`);
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`observation ${field} must be a non-empty string`);
  }
}

export function collectReferencedAuthorNames({ branchPagesRoot }) {
  const entries = fs.readdirSync(branchPagesRoot, { withFileTypes: true });
  const referenced = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(branchPagesRoot, entry.name, 'meta.json');
    let meta;
    try {
      meta = readJsonFile(metaPath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const field of AUTHOR_FIELDS) {
      const value = meta[field];
      if (typeof value !== 'string' || value.length === 0) continue;
      let record = referenced.get(value);
      if (record === undefined) {
        record = { pages: new Set(), roles: new Set() };
        referenced.set(value, record);
      }
      record.pages.add(meta.fullname ?? entry.name);
      record.roles.add(field);
    }
  }
  return new Map(
    [...referenced.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, record]) => [
        name,
        {
          pages: [...record.pages].sort(),
          roles: [...record.roles].sort(),
        },
      ]),
  );
}

function normalizeObservations(observations) {
  return (observations ?? []).map((observation, index) => {
    assertPositiveInteger(observation.user_id, `observations[${index}].user_id`);
    assertNonEmptyString(observation.name, `observations[${index}].name`);
    assertNonEmptyString(observation.slug, `observations[${index}].slug`);
    assertNonEmptyString(
      observation.source_reference,
      `observations[${index}].source_reference`,
    );
    return {
      user_id: observation.user_id,
      name: observation.name,
      slug: observation.slug,
      source_reference: observation.source_reference,
    };
  });
}

export function buildCorpusIdentityManifest({
  corpusRoot,
  branch,
  observations = [],
  profiles = [],
}) {
  if (typeof corpusRoot !== 'string' || corpusRoot.length === 0) {
    throw new Error('corpusRoot must be a non-empty string');
  }
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new Error('branch must be a non-empty string');
  }
  const referenced = collectReferencedAuthorNames({
    branchPagesRoot: path.join(corpusRoot, branch, 'pages'),
  });
  const banked = normalizeObservations(observations);
  const profiledIds = new Set(
    (profiles ?? []).map((profile) => {
      assertPositiveInteger(profile.user_id, 'profiles[].user_id');
      return profile.user_id;
    }),
  );

  const byName = new Map();
  const bySlug = new Map();
  for (const observation of banked) {
    if (!byName.has(observation.name)) byName.set(observation.name, []);
    byName.get(observation.name).push(observation);
    if (!bySlug.has(observation.slug)) bySlug.set(observation.slug, []);
    bySlug.get(observation.slug).push(observation);
  }

  const matched = [];
  const unmatchedNames = [];
  const ambiguous = [];
  for (const [name, record] of referenced) {
    const candidates = new Map();
    for (const observation of [
      ...(byName.get(name) ?? []),
      ...(bySlug.get(name) ?? []),
    ]) {
      candidates.set(observation.user_id, observation);
    }
    if (candidates.size === 0) {
      unmatchedNames.push({ name, ...record });
    } else if (candidates.size === 1) {
      const [observation] = [...candidates.values()];
      matched.push({
        name,
        ...record,
        user_id: observation.user_id,
        observed_name: observation.name,
        observed_slug: observation.slug,
        source_reference: observation.source_reference,
      });
    } else {
      ambiguous.push({
        name,
        ...record,
        user_ids: [...candidates.keys()].sort((a, b) => a - b),
      });
    }
  }

  const referencedIds = new Set(matched.map((row) => row.user_id));
  const unreferencedObservations = banked
    .filter((observation) => !referencedIds.has(observation.user_id))
    .map((observation) => ({ ...observation }))
    .sort((a, b) => a.user_id - b.user_id);

  const observedIds = [...new Set(banked.map((observation) => observation.user_id))].sort(
    (a, b) => a - b,
  );
  const idsWithoutProfiles = observedIds.filter((id) => !profiledIds.has(id));

  return {
    schema: CORPUS_IDENTITY_MANIFEST_SCHEMA,
    branch,
    matched,
    unmatched_names: unmatchedNames,
    ambiguous,
    unreferenced_observations: unreferencedObservations,
    ids_without_profiles: idsWithoutProfiles,
    summary: summarizeCorpusIdentityManifest({
      referencedCount: referenced.size,
      matched,
      unmatchedNames,
      ambiguous,
      idsWithoutProfiles,
    }),
  };
}

export function summarizeCorpusIdentityManifest({
  referencedCount,
  matched,
  unmatchedNames,
  ambiguous,
  idsWithoutProfiles,
}) {
  return {
    referenced_names: referencedCount,
    matched_names: matched.length,
    unmatched_names: unmatchedNames.length,
    ambiguous_names: ambiguous.length,
    observed_ids_without_profiles: idsWithoutProfiles.length,
  };
}
