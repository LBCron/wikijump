import { sha256Hex } from './canonical-json.mjs';

// A mirrored page renders through every page it includes (themes,
// components, info blocks), so importing a page without its transitive
// include dependencies leaves "does not exist" error blocks in otherwise
// healthy articles (Refs #2093). This module walks that closure over corpus
// sources so the manifest builder can materialize it. The same-site include
// contract matches the drift reporter (scripts/report-mirror-include-drift.mjs):
// includes inside @@...@@ spans and [!-- --] comments are display-only
// documentation, variable-dependent targets ({{...}}) cannot be resolved
// statically, and cross-site targets name another site's page.

export const INCLUDE_PATTERN = /\[\[\s*include\s+([^\s\]|]+)/giu;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9:_-]*$/u;
const CROSS_SITE_PATTERN = /^:([^:]+):(.+)$/u;
const VARIABLE_PATTERN = /\{\$/u;

export const DEFAULT_CLOSURE_MAX_DEPTH = 32;
export const DEFAULT_CLOSURE_MAX_PAGES = 10000;

export function includeTargetSlug(target, sourceSite) {
  let slug = target.trim();
  if (slug.includes('{$')) return null;
  const crossSite = CROSS_SITE_PATTERN.exec(slug);
  if (crossSite) {
    if (crossSite[1].toLowerCase() !== sourceSite) return null;
    slug = crossSite[2];
  }
  slug = slug.toLowerCase();
  return SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * Remove display-only spans from a source text. Raw @@...@@ spans and
 * [!-- --] comments can document include syntax without invoking it;
 * includes inside code blocks remain active under Wikidot's include
 * contract.
 */
export function stripInactiveSourceSpans(sourceText) {
  return sourceText
    .replace(/@@[^\r\n]*?@@/gu, '')
    .replace(/\[!--[\s\S]*?--\]/gu, '');
}

export function parseIncludeTargets(sourceText, sourceSite) {
  const sameSite = [];
  const seenSameSite = new Set();
  const external = [];
  const seenExternal = new Set();
  let dynamic = 0;
  const activeSource = stripInactiveSourceSpans(sourceText);
  INCLUDE_PATTERN.lastIndex = 0;
  for (const match of activeSource.matchAll(INCLUDE_PATTERN)) {
    const raw = match[1].trim();
    if (VARIABLE_PATTERN.test(raw)) {
      dynamic += 1;
      continue;
    }
    const crossSite = CROSS_SITE_PATTERN.exec(raw);
    if (crossSite && crossSite[1].toLowerCase() !== sourceSite.toLowerCase()) {
      const identity = `${crossSite[1].toLowerCase()}:${crossSite[2].toLowerCase()}`;
      if (!seenExternal.has(identity)) {
        seenExternal.add(identity);
        external.push(identity);
      }
      continue;
    }
    const slug = includeTargetSlug(raw, sourceSite);
    if (slug !== null && !seenSameSite.has(slug)) {
      seenSameSite.add(slug);
      sameSite.push(slug);
    }
  }
  INCLUDE_PATTERN.lastIndex = 0;
  return { sameSite, external, dynamic };
}

export function expandIncludeClosure({
  roots,
  readSource,
  pageExists,
  sourceSite,
  maxDepth = DEFAULT_CLOSURE_MAX_DEPTH,
  maxPages = DEFAULT_CLOSURE_MAX_PAGES,
}) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error('include closure requires at least one root slug');
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error('include closure maxDepth must be a non-negative integer');
  }
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error('include closure maxPages must be a positive integer');
  }
  const included = [];
  const seen = new Set();
  const unresolved = [];
  const seenUnresolved = new Set();
  const external = [];
  const seenExternal = new Set();
  let dynamic = 0;
  const truncated = [];
  const seenTruncated = new Set();
  const queue = roots.map((slug) => ({ slug, depth: 0, via: null }));
  while (queue.length > 0) {
    const { slug, depth, via } = queue.shift();
    if (seen.has(slug)) continue;
    seen.add(slug);
    if (seen.size > maxPages) {
      throw new Error(`include closure exceeds maxPages ${maxPages} at ${slug}`);
    }
    const source = readSource(slug);
    included.push({ slug, depth, via });
    if (source === null) {
      if (depth > 0 && !seenUnresolved.has(slug)) {
        seenUnresolved.add(slug);
        unresolved.push(slug);
      }
      continue;
    }
    if (depth >= maxDepth) {
      const targets = parseIncludeTargets(source, sourceSite);
      for (const target of targets.sameSite) {
        if (!seen.has(target) && !seenTruncated.has(target)) {
          seenTruncated.add(target);
          truncated.push(target);
        }
      }
      dynamic += targets.dynamic;
      for (const identity of targets.external) {
        if (!seenExternal.has(identity)) {
          seenExternal.add(identity);
          external.push(identity);
        }
      }
      continue;
    }
    const targets = parseIncludeTargets(source, sourceSite);
    dynamic += targets.dynamic;
    for (const identity of targets.external) {
      if (!seenExternal.has(identity)) {
        seenExternal.add(identity);
        external.push(identity);
      }
    }
    for (const target of targets.sameSite) {
      if (seen.has(target)) continue;
      if (!pageExists(target)) {
        if (!seenUnresolved.has(target)) {
          seenUnresolved.add(target);
          unresolved.push(target);
        }
        continue;
      }
      queue.push({ slug: target, depth: depth + 1, via: slug });
    }
  }
  return { included, unresolved, external, dynamic, truncated };
}

export const CORPUS_SITE_PREFERRED_BRANCHES = {
  'scp-wiki': 'en',
  'scp-jp': 'jp',
  'scp-wiki-cn': 'cn',
  'scpko': 'ko',
  'scp-int': 'int',
  'fondazionescp': 'it',
  'fondationscp': 'fr',
  'lafundacionscp': 'es',
  'destinox': 'es',
  '05command': '05command',
};

export function expandCrossSiteIncludeClosure({
  roots,
  branches,
  preferredBranches = CORPUS_SITE_PREFERRED_BRANCHES,
  maxDepth = DEFAULT_CLOSURE_MAX_DEPTH,
  maxPages = DEFAULT_CLOSURE_MAX_PAGES,
}) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error('cross-site include closure requires at least one root identity');
  }
  if (typeof branches !== 'object' || branches === null || Array.isArray(branches)) {
    throw new Error('cross-site include closure requires a branches map');
  }
  const branchNames = Object.keys(branches).sort();
  if (branchNames.length === 0) {
    throw new Error('cross-site include closure requires at least one searchable branch');
  }
  for (const name of branchNames) {
    const access = branches[name];
    for (const method of ['pageExists', 'readSource', 'readProvenance']) {
      if (typeof access?.[method] !== 'function') {
        throw new Error(`cross-site include closure branch ${name} must provide ${method}`);
      }
    }
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error('cross-site include closure maxDepth must be a non-negative integer');
  }
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error('cross-site include closure maxPages must be a positive integer');
  }
  for (const root of roots) {
    if (typeof root?.branch !== 'string' || typeof root?.slug !== 'string' || typeof root?.site !== 'string' || root.site === '') {
      throw new Error('cross-site include closure roots must be { branch, site, slug } identities');
    }
    if (!Object.hasOwn(branches, root.branch)) {
      throw new Error(`cross-site include closure root branch is not searchable: ${root.branch}`);
    }
  }

  const identityKey = (branch, slug) => `${branch}\0${slug}`;
  const included = [];
  const seen = new Set();
  const gaps = [];
  const seenGaps = new Set();
  let dynamic = 0;
  const truncated = [];
  const seenTruncated = new Set();
  const queue = roots.map(({ branch, site, slug }) => ({ branch, site, slug, depth: 0, via: null }));

  const reportGap = (gap) => {
    const key = `${gap.identity}\0${gap.reason}`;
    if (seenGaps.has(key)) return;
    seenGaps.add(key);
    gaps.push(gap);
  };

  const resolveForeign = (fromBranch, site, slug) => {
    const hits = [];
    for (const name of branchNames) {
      if (name === fromBranch) continue;
      if (branches[name].pageExists(slug)) hits.push(name);
    }
    if (hits.length <= 1) {
      return { branch: hits[0] ?? null, alsoIn: [], divergent: [], resolution: hits.length === 1 ? 'unique-hit' : null };
    }
    const byContent = new Map();
    for (const name of hits) {
      const source = branches[name].readSource(slug);
      const digest = source === null ? 'missing' : sha256Hex(source);
      if (!byContent.has(digest)) byContent.set(digest, []);
      byContent.get(digest).push(name);
    }
    if (byContent.size === 1) {
      return { branch: hits[0], alsoIn: hits.slice(1), divergent: [], resolution: 'identical-content' };
    }
    const preferred = preferredBranches[site];
    if (typeof preferred === 'string' && hits.includes(preferred)) {
      return { branch: preferred, alsoIn: hits.filter((name) => name !== preferred), divergent: [], resolution: 'preferred-branch' };
    }
    return {
      branch: null,
      alsoIn: [],
      divergent: [...byContent.entries()].map(([digest, names]) => `${names.join('+')}@${digest.slice(0, 12)}`),
      resolution: null,
    };
  };

  while (queue.length > 0) {
    const { branch, site, slug, depth, via, alsoIn = [], resolution = null } = queue.shift();
    const key = identityKey(branch, slug);
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > maxPages) {
      throw new Error(`cross-site include closure exceeds maxPages ${maxPages} at ${branch}:${slug}`);
    }
    const access = branches[branch];
    const source = access.readSource(slug);
    included.push({
      branch,
      site,
      slug,
      depth,
      via,
      also_in: alsoIn,
      resolution,
      provenance: access.readProvenance(slug),
    });
    if (source === null) {
      if (depth > 0) {
        reportGap({
          identity: `${branch}:${slug}`,
          branch,
          site,
          via,
          reason: 'absent-from-corpus',
          detail: `corpus branch ${branch} has no source for ${slug}`,
        });
      }
      continue;
    }
    const targets = parseIncludeTargets(source, site);
    dynamic += targets.dynamic;
    const enqueue = (targetBranch, targetSite, targetSlug, alsoIn = [], resolution = 'same-branch') => {
      if (seen.has(identityKey(targetBranch, targetSlug))) return;
      if (depth + 1 > maxDepth) {
        const identity = `${targetBranch}:${targetSlug}`;
        if (!seenTruncated.has(identity)) {
          seenTruncated.add(identity);
          truncated.push(identity);
        }
        return;
      }
      queue.push({ branch: targetBranch, site: targetSite, slug: targetSlug, depth: depth + 1, via: `${branch}:${slug}`, alsoIn, resolution });
    };
    for (const target of targets.sameSite) {
      if (!branches[branch].pageExists(target)) {
        reportGap({
          identity: `${branch}:${target}`,
          branch,
          site,
          via: `${branch}:${slug}`,
          reason: 'absent-from-corpus',
          detail: `corpus branch ${branch} has no source for ${target}`,
        });
        continue;
      }
      enqueue(branch, site, target);
    }
    for (const identity of targets.external) {
      const separator = identity.indexOf(':');
      const foreignSite = identity.slice(0, separator);
      const foreignSlug = identity.slice(separator + 1);
      const resolved = resolveForeign(branch, foreignSite, foreignSlug);
      if (resolved.branch !== null) {
        enqueue(resolved.branch, foreignSite, foreignSlug, resolved.alsoIn, resolved.resolution);
      } else if (resolved.divergent.length === 0) {
        reportGap({
          identity,
          branch: null,
          site: foreignSite,
          via: `${branch}:${slug}`,
          reason: 'absent-from-corpus',
          detail: `no searchable branch holds ${foreignSlug} for site ${foreignSite}`,
        });
      } else {
        reportGap({
          identity,
          branch: null,
          site: foreignSite,
          via: `${branch}:${slug}`,
          reason: 'ambiguous-branches',
          detail: `divergent sources: ${resolved.divergent.join(', ')}`,
        });
      }
    }
  }
  return { included, gaps, dynamic, truncated };
}
