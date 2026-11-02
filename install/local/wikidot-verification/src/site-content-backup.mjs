import fs from 'node:fs';
import path from 'node:path';

import {
  buildCorpusImportManifest,
  sha256Hex,
  stableStringify,
} from './corpus-import-manifest.mjs';

export const SITE_CONTENT_BACKUP_SCHEMA = 'wikijump.site-content-backup.v1';
export const SITE_CONTENT_BACKUP_MANIFEST_FILENAME = 'backup-manifest.json';
export const DEFAULT_SITE_CONTENT_BACKUP_LIMITS = Object.freeze({
  maxPages: 10_000,
  maxAttachments: 100_000,
  maxContentBytes: 512 * 1024 * 1024,
});

const PAGE_METADATA_FIELDS = [
  'children',
  'commented_at',
  'commented_by',
  'comments',
  'created_at',
  'created_by',
  'fullname',
  'parent_fullname',
  'parent_title',
  'rating',
  'revisions',
  'tags',
  'title',
  'title_shown',
  'updated_at',
  'updated_by',
];

function assertSafePathComponent(value, field) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`${field} must be one safe path component`);
  }
}

function assertLimit(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function normalizeLimits(limits) {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new Error('limits must be an object');
  }
  const normalized = {
    ...DEFAULT_SITE_CONTENT_BACKUP_LIMITS,
    ...limits,
  };
  assertLimit(normalized.maxPages, 'limits.maxPages');
  assertLimit(normalized.maxAttachments, 'limits.maxAttachments');
  assertLimit(normalized.maxContentBytes, 'limits.maxContentBytes');
  return normalized;
}

function addBounded(left, right, field) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new Error(`${field} exceeds the safe integer range`);
  }
  return sum;
}

function pageMetaFromRow(row) {
  const meta = Object.fromEntries(
    PAGE_METADATA_FIELDS.map((field) => [
      field,
      field === 'title_shown' ? row.title_shown ?? row.title : row[field],
    ]),
  );
  if (row.wikidot_size !== null) meta.size = row.wikidot_size;
  meta.source_bytes = row.source_bytes;
  meta.source_sha256 = row.source_sha256;
  return meta;
}

function attachmentManifestEntry(attachment, pageDir) {
  assertSafePathComponent(attachment.filename, `${pageDir} attachment filename`);
  return {
    filename: attachment.filename,
    original_url: attachment.original_url,
    wikidot_path: attachment.wikidot_path,
    path: `files/${attachment.filename}`,
    sha256: attachment.sha256,
    mime: attachment.mime,
    ...(attachment.content_type_description === undefined
      ? {}
      : { mime_description: attachment.content_type_description }),
    size: attachment.size,
  };
}

function pageManifestEntry(row) {
  assertSafePathComponent(row.fullname, 'page fullname');
  const pagePath = `pages/${row.fullname}`;
  const attachments = (row.attachments ?? []).map((attachment) => {
    const manifestEntry = attachmentManifestEntry(attachment, row.fullname);
    return {
      archive_path: `${pagePath}/${manifestEntry.path}`,
      filename: manifestEntry.filename,
      original_url: manifestEntry.original_url,
      wikidot_path: manifestEntry.wikidot_path,
      sha256: manifestEntry.sha256,
      mime: manifestEntry.mime,
      ...(manifestEntry.mime_description === undefined
        ? {}
        : { mime_description: manifestEntry.mime_description }),
      size: manifestEntry.size,
    };
  });
  return {
    fullname: row.fullname,
    source_path: `${pagePath}/source.wikidot.txt`,
    source_sha256: row.source_sha256,
    source_bytes: row.source_bytes,
    attachments,
  };
}

function buildBackupManifest(rows, branch, sourceSite, sourceBranch, limits) {
  const pages = rows.map(pageManifestEntry);
  const attachmentCount = pages.reduce((count, page) => count + page.attachments.length, 0);
  const sourceBytes = rows.reduce(
    (total, row) => addBounded(total, row.source_bytes, 'source bytes'),
    0,
  );
  const attachmentBytes = rows.reduce(
    (total, row) => row.attachments?.reduce(
      (attachmentTotal, attachment) => addBounded(attachmentTotal, attachment.size, 'attachment bytes'),
      total,
    ) ?? total,
    0,
  );
  const contentBytes = addBounded(sourceBytes, attachmentBytes, 'content bytes');

  if (pages.length > limits.maxPages) {
    throw new Error(`site content backup exceeds page bound: ${pages.length} > ${limits.maxPages}`);
  }
  if (attachmentCount > limits.maxAttachments) {
    throw new Error(`site content backup exceeds attachment bound: ${attachmentCount} > ${limits.maxAttachments}`);
  }
  if (contentBytes > limits.maxContentBytes) {
    throw new Error(`site content backup exceeds content-byte bound: ${contentBytes} > ${limits.maxContentBytes}`);
  }

  const archivePaths = new Set();
  for (const page of pages) {
    if (archivePaths.has(page.source_path)) {
      throw new Error(`duplicate site content backup archive path: ${page.source_path}`);
    }
    archivePaths.add(page.source_path);
    for (const attachment of page.attachments) {
      if (archivePaths.has(attachment.archive_path)) {
        throw new Error(`duplicate site content backup archive path: ${attachment.archive_path}`);
      }
      archivePaths.add(attachment.archive_path);
    }
  }

  return {
    schema: SITE_CONTENT_BACKUP_SCHEMA,
    representation: 'source-bundle-directory',
    scope: 'pages+attachments',
    source_site: sourceSite,
    source_branch: sourceBranch,
    branch,
    counts: {
      pages: pages.length,
      attachments: attachmentCount,
      source_bytes: sourceBytes,
      attachment_bytes: attachmentBytes,
      content_bytes: contentBytes,
    },
    pages,
  };
}

function writeJsonNoReplace(filePath, value) {
  fs.writeFileSync(filePath, `${stableStringify(value)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

function writeBytesNoReplace(filePath, bytes) {
  fs.writeFileSync(filePath, bytes, { flag: 'wx' });
}

function writePageBundle(outputRoot, row) {
  const pageDir = path.join(outputRoot, 'pages', row.fullname);
  fs.mkdirSync(pageDir);

  const sourceBytes = fs.readFileSync(row.source_path);
  if (sha256Hex(sourceBytes) !== row.source_sha256 || sourceBytes.length !== row.source_bytes) {
    throw new Error(`${row.fullname}: source changed while creating site content backup`);
  }
  writeBytesNoReplace(path.join(pageDir, 'source.wikidot.txt'), sourceBytes);
  writeJsonNoReplace(path.join(pageDir, 'meta.json'), pageMetaFromRow(row));

  const files = (row.attachments ?? []).map((attachment) => attachmentManifestEntry(attachment, row.fullname));
  writeJsonNoReplace(path.join(pageDir, 'files.json'), files);
  if (files.length === 0) return;

  const filesDir = path.join(pageDir, 'files');
  fs.mkdirSync(filesDir);
  for (const [index, attachment] of files.entries()) {
    const sourcePath = row.attachments[index].file_path;
    const bytes = fs.readFileSync(sourcePath);
    if (sha256Hex(bytes) !== attachment.sha256 || bytes.length !== attachment.size) {
      throw new Error(`${row.fullname}/${attachment.filename}: attachment changed while creating site content backup`);
    }
    writeBytesNoReplace(path.join(filesDir, attachment.filename), bytes);
  }
}

export function writeSiteContentBackup({
  corpusRoot,
  branch,
  sourceSite = null,
  sourceBranch = null,
  fullnames = null,
  outputRoot,
  limits = DEFAULT_SITE_CONTENT_BACKUP_LIMITS,
}) {
  if (typeof outputRoot !== 'string' || outputRoot.length === 0) {
    throw new Error('outputRoot must be a non-empty path');
  }
  const normalizedLimits = normalizeLimits(limits);
  const rows = buildCorpusImportManifest({
    corpusRoot,
    branch,
    sourceSite,
    sourceBranch,
    fullnames,
  });
  const effectiveSourceSite = rows[0]?.source_site ?? sourceSite ?? branch;
  const effectiveSourceBranch = rows[0]?.source_branch ?? sourceBranch ?? branch;
  const manifest = buildBackupManifest(
    rows,
    branch,
    effectiveSourceSite,
    effectiveSourceBranch,
    normalizedLimits,
  );

  const absoluteOutputRoot = path.resolve(outputRoot);
  if (fs.existsSync(absoluteOutputRoot)) {
    throw new Error(`site content backup output already exists: ${absoluteOutputRoot}`);
  }
  const outputParent = path.dirname(absoluteOutputRoot);
  fs.mkdirSync(outputParent, { recursive: true });
  const stagingRoot = fs.mkdtempSync(
    path.join(outputParent, `.${path.basename(absoluteOutputRoot)}.staging-`),
  );
  try {
    fs.mkdirSync(path.join(stagingRoot, 'pages'));
    for (const row of rows) writePageBundle(stagingRoot, row);
    writeJsonNoReplace(
      path.join(stagingRoot, SITE_CONTENT_BACKUP_MANIFEST_FILENAME),
      manifest,
    );
    fs.renameSync(stagingRoot, absoluteOutputRoot);
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  const manifestPath = path.join(absoluteOutputRoot, SITE_CONTENT_BACKUP_MANIFEST_FILENAME);

  return {
    outputRoot: absoluteOutputRoot,
    manifestPath,
    manifest,
  };
}
