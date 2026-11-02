import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {resolveExistingContainedFile, resolveExistingContainedFileWithoutSymlinks} from './package-path.mjs';
import {framerailSourceFingerprintSyncMemoized} from './framerail-source-fingerprint-memo.mjs';
import {requireDeepwellRuntimeIdentity} from './deepwell-runtime-identity.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const IDENTITY_FIELDS = ['inventory', 'nodes', 'edges', 'attachments', 'targeted_scenarios', 'authority'];
const IDENTITY_CONTRACT = 'sha256(JSON.stringify({inventory,nodes,edges,attachments,targeted_scenarios,authority}))';

export function frozenCandidateSetSha256(frozen) {
  const identity = Object.fromEntries(IDENTITY_FIELDS.map(field => [field, frozen?.[field]]));
  return sha(Buffer.from(JSON.stringify(identity)));
}

function readJson(root, relative, label, failures) {
  try {
    const file = resolveExistingContainedFile(root, relative, label);
    return {file, bytes: fs.readFileSync(file), value: JSON.parse(fs.readFileSync(file, 'utf8'))};
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    return null;
  }
}

function graphNodeIdentity(node) {
  return Object.fromEntries(['id', 'site', 'action', 'publication_source', 'source_sha256', 'candidate_css_sha256', 'upstream', 'current_jp_source', 'status']
    .map(key => [key, node?.[key] ?? null]));
}

function containedRelative(root, file, label, baseDirectory = root) {
  return resolveExistingContainedFile(root, file, label, baseDirectory);
}

// Legacy BHL option captures record the absolute pathname of their original
// acceptance worktree. The receipt bytes are SHA-bound by the frozen candidate
// set, so changing those path strings would invalidate the evidence. Resolve
// only the known BHL capture directory within the current evidence checkout;
// the caller still verifies the captured screenshot's exact SHA-256.
const BHL_CAPTURE_PREFIX = 'ports/black-highlighter-theme/option-scenarios/captures/';
const LEGACY_THEME_LAB_SEPARATOR = '/install/local/theme-lab/';

export function canonicalBhlScreenshotPath(root, recordedPath) {
  if (typeof recordedPath !== 'string' || !recordedPath) {
    throw new Error('BHL screenshot path is missing');
  }
  const pathFromRoot = path.isAbsolute(recordedPath)
    ? path.relative(root, recordedPath)
    : recordedPath;
  const relative = pathFromRoot.startsWith(BHL_CAPTURE_PREFIX)
    ? pathFromRoot
    : recordedPath.startsWith('/') && recordedPath.includes(LEGACY_THEME_LAB_SEPARATOR)
      ? recordedPath.slice(recordedPath.lastIndexOf(LEGACY_THEME_LAB_SEPARATOR) + LEGACY_THEME_LAB_SEPARATOR.length)
      : null;
  if (!relative?.startsWith(BHL_CAPTURE_PREFIX)) {
    throw new Error('BHL screenshot is outside the frozen capture directory');
  }
  // Require a real, confined PNG. Do not normalize away traversal or follow a
  // symlink; resolveExistingContainedFile checks each path component.
  if (relative.split('/').some(part => part === '..' || part === '.' || part === '') ||
      !relative.endsWith('.png')) {
    throw new Error('BHL screenshot path is not a confined PNG');
  }
  resolveExistingContainedFileWithoutSymlinks(root, relative, 'BHL screenshot');
  return relative;
}

function authorityRecordContains(value, slug, sourceSha256) {
  let found = false;
  const visit = current => {
    if (!current || typeof current !== 'object' || found) return;
    if (!Array.isArray(current) && Object.values(current).includes(slug) && JSON.stringify(current).includes(sourceSha256)) {
      found = true;
      return;
    }
    for (const child of Array.isArray(current) ? current : Object.values(current)) visit(child);
  };
  visit(value);
  return found;
}

// 'identity' skips only the targeted evidence section (receipts, screenshots,
// visual reviews, and the evidence bindings). Every other check still runs.
// 'full' is the completion-gate scope and is the default.
export const CANDIDATE_SET_SCOPES = Object.freeze(['identity', 'full']);

function validateBhlTargetedEvidence(root, frozen, graph, failures, scope = 'full') {
  const scenarios = frozen.targeted_scenarios ?? [];
  const bhlScenarios = scenarios.filter(scenario => scenario.id?.startsWith('bhl-options-'));
  if (!bhlScenarios.length) return;

  const authorityPath = 'ports/black-highlighter-theme/option-scenarios/authority.json';
  const authorityArtifact = readJson(root, authorityPath, 'Current BHL option authority', failures);
  if (!authorityArtifact) return;
  const authoritySha = sha(authorityArtifact.bytes);
  const expectedAuthoritySha = frozen.authority?.bhl_option_authority_sha256;
  if (authoritySha !== expectedAuthoritySha) failures.push('Frozen candidate set BHL option authority SHA is stale');
  let expectedBackendIdentity = null;
  try {
    expectedBackendIdentity = requireDeepwellRuntimeIdentity(authorityArtifact.value.backend_runtime_identity, 'Current BHL option authority');
    if (expectedBackendIdentity.identity_sha256 !== frozen.authority?.bhl_backend_runtime_identity_sha256)
      failures.push('Frozen candidate set BHL Deepwell backend identity is stale');
  } catch (error) {
    failures.push(`Current BHL option authority lacks a valid Deepwell backend identity: ${error.message}`);
  }
  const runtimeRepoRoot = path.resolve(root, '../../..');
  try {
    const currentFramerail = framerailSourceFingerprintSyncMemoized(runtimeRepoRoot);
    if (currentFramerail !== authorityArtifact.value.framerail?.fingerprint_sha256 || currentFramerail !== frozen.authority?.bhl_framerail_fingerprint_sha256)
      failures.push('Frozen candidate set BHL Framerail fingerprint is stale');
  } catch (error) {
    failures.push(`Current BHL Framerail fingerprint cannot be verified: ${error.message}`);
  }

  for (const page of authorityArtifact.value.pages ?? []) {
    try {
      const pagePath = `ports/black-highlighter-theme/option-scenarios/${page.snapshot_path}`;
      const bytes = fs.readFileSync(containedRelative(root, pagePath, `BHL authority source ${page.slug}`));
      if (sha(bytes) !== page.source_sha256) failures.push(`BHL option authority source changed: ${page.slug}`);
    } catch (error) {
      failures.push(`BHL option authority source is unavailable: ${page.slug}: ${error.message}`);
    }
  }

  const frozenTheme = frozen.nodes?.find(node => node.id === 'theme:black-highlighter-theme');
  const expectedReceipts = [];
  const expectedScreenshots = [];
  for (const scenario of bhlScenarios) {
    if (scenario.current_authority_sha256 !== authoritySha) failures.push(`${scenario.id}: frozen scenario uses stale BHL option authority`);
    if (scenario.theme_candidate_source_sha256 !== frozenTheme?.source_sha256 || scenario.theme_candidate_css_sha256 !== frozenTheme?.candidate_css_sha256)
      failures.push(`${scenario.id}: frozen scenario uses a stale BHL theme candidate`);
    if (scope === 'identity') continue;
    const evidence = frozen.targeted_evidence_bindings?.find(binding => binding.scenario_id === scenario.id);
    if (!evidence) {
      failures.push(`${scenario.id}: frozen targeted evidence bindings are missing`);
      continue;
    }
    const expectedScenario = scenario.id === 'bhl-options-toggle-header-dark' ? 'combined' : 'collapsible';
    const receiptBindings = new Map((evidence.receipts ?? []).map(binding => [binding.path, binding]));
    if ((scenario.receipt_evidence ?? []).length !== receiptBindings.size || (scenario.receipt_evidence ?? []).some(file => !receiptBindings.has(file)))
      failures.push(`${scenario.id}: receipt list differs from its frozen evidence bindings`);
    for (const receiptPath of scenario.receipt_evidence ?? []) {
      const binding = receiptBindings.get(receiptPath);
      try {
        const receiptBytes = fs.readFileSync(containedRelative(root, receiptPath, `${scenario.id} receipt`));
        if (sha(receiptBytes) !== binding?.sha256) failures.push(`${scenario.id}: targeted receipt changed: ${receiptPath}`);
        const receipt = JSON.parse(receiptBytes);
        const {receipt_sha256: receiptSha, ...receiptBody} = receipt;
        if (!receiptSha || sha(Buffer.from(JSON.stringify(receiptBody))) !== receiptSha) failures.push(`${scenario.id}: targeted receipt integrity hash is invalid: ${receiptPath}`);
        let receiptBackendIdentity = null;
        try {
          receiptBackendIdentity = requireDeepwellRuntimeIdentity(receipt.backend_runtime_identity, `${scenario.id} receipt`);
          if (!expectedBackendIdentity || receiptBackendIdentity.identity_sha256 !== expectedBackendIdentity.identity_sha256 ||
              receipt.backend_runtime_identity_sha256 !== receiptBackendIdentity.identity_sha256)
            failures.push(`${scenario.id}: targeted receipt uses a stale or incomplete Deepwell backend identity: ${receiptPath}`);
        } catch (error) {
          failures.push(`${scenario.id}: targeted receipt lacks a valid Deepwell backend identity: ${receiptPath}: ${error.message}`);
        }
        if (receipt.candidate_set_sha256 !== frozen.candidate_set_sha256) failures.push(`${scenario.id}: targeted receipt is not bound to the frozen candidate set: ${receiptPath}`);
        if (receipt.scenario !== expectedScenario || receipt.source_authority_sha256 !== authoritySha ||
            receipt.candidate_source_sha256 !== frozenTheme?.source_sha256 || receipt.candidate_css_sha256 !== frozenTheme?.candidate_css_sha256 ||
            receipt.framerail_fingerprint_sha256 !== frozen.authority?.bhl_framerail_fingerprint_sha256 ||
            receipt.option_css_sha256 !== scenario.option_css_sha256)
          failures.push(`${scenario.id}: targeted receipt authority differs from the frozen candidate set: ${receiptPath}`);
        const engine = path.basename(receiptPath).match(/-(chromium|firefox|webkit)\.json$/u)?.[1];
        const baseline = path.basename(receiptPath).match(/-(sigma9|sigma10)-/u)?.[1];
        if (!engine || !baseline || receipt.browser_engine !== engine || receipt.baseline?.toLowerCase() !== (baseline === 'sigma9' ? 'sigma-9' : 'sigma-10'))
          failures.push(`${scenario.id}: receipt file identity differs from its contents: ${receiptPath}`);
        const rows = receipt.rows ?? [];
        for (const row of rows) {
          if (row.assertion_failures?.length || row.external_requests_sent !== 0 || row.page_errors?.length)
            failures.push(`${scenario.id}: targeted capture has unresolved runtime failures: ${receiptPath}/${row.state}`);
          if (row.source_authority_sha256 !== authoritySha || row.candidate?.source_sha256 !== frozenTheme?.source_sha256 ||
              row.candidate?.css_sha256 !== frozenTheme?.candidate_css_sha256 ||
              row.framerail_fingerprint_sha256 !== frozen.authority?.bhl_framerail_fingerprint_sha256)
            failures.push(`${scenario.id}: targeted capture row uses stale source/runtime authority: ${receiptPath}/${row.state}`);
          try {
            const rowBackendIdentity = requireDeepwellRuntimeIdentity(row.backend_runtime_identity, `${scenario.id} row ${row.state}`);
            if (!expectedBackendIdentity || rowBackendIdentity.identity_sha256 !== expectedBackendIdentity.identity_sha256 ||
                row.backend_runtime_identity_sha256 !== rowBackendIdentity.identity_sha256)
              failures.push(`${scenario.id}: targeted capture row uses a stale or incomplete Deepwell backend identity: ${receiptPath}/${row.state}`);
          } catch (error) {
            failures.push(`${scenario.id}: targeted capture row lacks a valid Deepwell backend identity: ${receiptPath}/${row.state}: ${error.message}`);
          }
          if (!isDeepStrictEqual(row.option_candidates ?? [], authorityArtifact.value.option_candidates ?? []))
            failures.push(`${scenario.id}: targeted capture row has stale option candidates: ${receiptPath}/${row.state}`);
          try {
            const screenshotPath = canonicalBhlScreenshotPath(root, row.screenshot);
            const screenshotBytes = fs.readFileSync(containedRelative(root, screenshotPath, `${scenario.id} screenshot`));
            if (sha(screenshotBytes) !== row.screenshot_sha256) failures.push(`${scenario.id}: screenshot changed: ${row.screenshot}`);
            expectedScreenshots.push({path: screenshotPath, sha256: row.screenshot_sha256, receipt_path: receiptPath, state: row.state, baseline: receipt.baseline, browser_engine: receipt.browser_engine, viewport: row.viewport});
          } catch (error) {
            failures.push(`${scenario.id}: screenshot is unavailable: ${row.screenshot}: ${error.message}`);
          }
        }
        expectedReceipts.push({path: receiptPath, sha256: sha(receiptBytes)});
      } catch (error) {
        failures.push(`${scenario.id}: targeted receipt is unavailable: ${receiptPath}: ${error.message}`);
      }
    }
    const reviewBinding = evidence.visual_review;
    if (!reviewBinding || reviewBinding.path !== scenario.visual_review) {
      failures.push(`${scenario.id}: visual review path differs from the frozen scenario`);
      continue;
    }
    try {
      const reviewBytes = fs.readFileSync(containedRelative(root, reviewBinding.path, `${scenario.id} visual review`));
      if (sha(reviewBytes) !== reviewBinding.sha256) failures.push(`${scenario.id}: visual review changed`);
      const review = JSON.parse(reviewBytes);
      const reviewScenario = review.scenarios?.find(row => row.id === scenario.id);
      if ((reviewScenario?.status ?? review.status) !== 'pass' || !(reviewScenario?.reviewer ?? review.reviewer) || !/human|direct/iu.test(review.review_method ?? ''))
        failures.push(`${scenario.id}: direct human visual review is missing`);
      if (review.candidate_set_sha256 !== frozen.candidate_set_sha256 || review.source_authority_sha256 !== authoritySha ||
          review.framerail_fingerprint_sha256 !== frozen.authority?.bhl_framerail_fingerprint_sha256 ||
          review.backend_runtime_identity_sha256 !== expectedBackendIdentity?.identity_sha256 ||
          review.candidate_identity?.theme_candidate_source_sha256 !== frozenTheme?.source_sha256 ||
          review.candidate_identity?.theme_candidate_css_sha256 !== frozenTheme?.candidate_css_sha256)
        failures.push(`${scenario.id}: visual review is not bound to the frozen candidate/source authority`);
      const actualReceipts = (reviewScenario?.receipts ?? review.receipts ?? []).map(({path: file, sha256: hash}) => ({path: file, sha256: hash})).sort((a,b) => a.path.localeCompare(b.path));
      if (!isDeepStrictEqual(actualReceipts, expectedReceipts.filter(receipt => scenario.receipt_evidence.includes(receipt.path)).sort((a,b) => a.path.localeCompare(b.path))))
        failures.push(`${scenario.id}: visual review does not name the exact targeted receipts`);
      const expectedRows = expectedScreenshots.filter(row => scenario.receipt_evidence.includes(row.receipt_path)).map(({path: file, sha256: hash}) => ({path: file, sha256: hash})).sort((a,b) => a.path.localeCompare(b.path));
      const actualRows = (reviewScenario?.screenshots ?? review.screenshots ?? []).map(({path: file, sha256: hash}) => ({path: file, sha256: hash})).sort((a,b) => a.path.localeCompare(b.path));
      if (!isDeepStrictEqual(actualRows, expectedRows)) failures.push(`${scenario.id}: visual review does not bind every exact screenshot SHA`);
      expectedReceipts.push({path: reviewBinding.path, sha256: sha(reviewBytes)});
    } catch (error) {
      failures.push(`${scenario.id}: visual review is unavailable: ${error.message}`);
    }
  }
  if (scope === 'identity') return;
  for (const binding of frozen.targeted_evidence_bindings ?? []) {
    const required = binding.scenario_id && bhlScenarios.some(scenario => scenario.id === binding.scenario_id);
    if (!required) failures.push(`Unexpected frozen targeted evidence binding: ${binding.scenario_id ?? 'missing scenario id'}`);
  }
}

// documents, when given, replaces the publication files that the generator has
// not written yet: {frozen: {value}, graph: {value}, readiness: {bytes, value}}.
// Byte and identity checks still run on the replacements. Omit it to validate
// the files in the checkout.
// scope 'full' (default) runs every check. scope 'identity' runs every check except
// the targeted evidence section (receipts, screenshots, visual reviews, bindings).
export function validatePublicationCandidateSet(root, {expectedCandidateSetSha256, contract, label = 'Publication candidate set', documents = null, scope = 'full'} = {}) {
  if (!CANDIDATE_SET_SCOPES.includes(scope)) throw new Error(`unknown candidate-set validation scope: ${scope}`);
  const failures = [];
  const frozenArtifact = documents?.frozen ?? readJson(root, 'publication/frozen-candidate-set.json', 'Frozen publication candidate set', failures);
  if (!frozenArtifact) return failures;
  const frozen = frozenArtifact.value;
  const calculated = frozenCandidateSetSha256(frozen);
  if (frozen.identity_contract !== IDENTITY_CONTRACT || calculated !== frozen.candidate_set_sha256)
    failures.push(`${label}: frozen candidate-set identity does not match its canonical content`);
  if (expectedCandidateSetSha256 && expectedCandidateSetSha256 !== frozen.candidate_set_sha256)
    failures.push(`${label}: run contract is not bound to the current frozen candidate-set identity`);
  if (contract && contract.candidate_set_sha256 !== frozen.candidate_set_sha256)
    failures.push(`${label}: run contract candidate_set_sha256 is missing or stale`);
  if (frozen.state !== 'frozen-before-final-acceptance') failures.push(`${label}: candidate set is not frozen for final acceptance`);

  const graphArtifact = documents?.graph ?? readJson(root, 'publication/dependency-graph.json', 'Current publication dependency graph', failures);
  if (graphArtifact) {
    const graph = graphArtifact.value;
    const freeze = graph.candidate_freeze ?? {};
    if (freeze.state !== frozen.state || freeze.candidate_set_sha256 !== frozen.candidate_set_sha256)
      failures.push(`${label}: dependency graph is bound to a different publication freeze`);
    const frozenNodes = frozen.nodes ?? [];
    const graphNodes = graph.nodes ?? [];
    if (new Set(frozenNodes.map(node => node.id)).size !== frozenNodes.length || new Set(graphNodes.map(node => node.id)).size !== graphNodes.length ||
        frozenNodes.length !== graphNodes.length || frozenNodes.some(node => !graphNodes.some(current => current.id === node.id && isDeepStrictEqual(graphNodeIdentity(current), graphNodeIdentity(node)))))
      failures.push(`${label}: frozen publication node identities differ from the current dependency graph`);
    const frozenNodesById = new Map(frozenNodes.map(node => [node.id, node]));
    const visitPublicationReferences = (value, location) => {
      if (!value || typeof value !== 'object') return;
      if (!Array.isArray(value) && value.publication_node && typeof value.publication_node === 'object') {
        const id = value.id ?? value.slug ?? value.locator;
        const frozenNode = frozenNodesById.get(id);
        if (frozenNode) {
          for (const field of ['action', 'status', 'source_sha256']) {
            if (Object.hasOwn(value.publication_node, field) && value.publication_node[field] !== (frozenNode[field] ?? null))
              failures.push(`${label}: nested publication reference differs from its frozen node: ${id}/${field} (${location})`);
          }
        }
      }
      if (Array.isArray(value)) value.forEach((child, index) => visitPublicationReferences(child, `${location}[${index}]`));
      else for (const [key, child] of Object.entries(value)) visitPublicationReferences(child, `${location}.${key}`);
    };
    visitPublicationReferences(graphNodes, 'dependency-graph.nodes');
    if (!isDeepStrictEqual(frozen.edges ?? [], graph.edges ?? [])) failures.push(`${label}: frozen actionable dependencies differ from the current dependency graph`);
    if (!isDeepStrictEqual(frozen.targeted_scenarios ?? [], graph.targeted_scenarios ?? [])) failures.push(`${label}: frozen targeted scenario source bindings differ from the current dependency graph`);
    const frozenAttachmentsByNode=new Map();
    for(const attachment of frozen.attachments??[]){
      const current=frozenAttachmentsByNode.get(attachment.node)??[];
      current.push(attachment);
      frozenAttachmentsByNode.set(attachment.node,current);
    }
    for(const node of graphNodes){
      const listed=node.attachments??[];
      const expected=frozenAttachmentsByNode.get(node.id)??[];
      if(!Array.isArray(listed)||listed.length!==expected.length){
        failures.push(`${label}: publication graph attachment list differs from its frozen inventory: ${node.id}`);
        continue;
      }
      for(const item of listed){
        if(!item||typeof item!=='object'||typeof item.filename!=='string'||typeof item.source!=='string'){
          failures.push(`${label}: publication graph attachment lacks an exact filename/source record: ${node.id}`);
          continue;
        }
        const frozenItem=expected.find(candidate=>candidate.filename===item.filename);
        let graphSource=null,frozenSource=null;
        try{graphSource=path.resolve(path.join(root,'publication'),item.source)}catch{}
        try{frozenSource=path.resolve(root, frozenItem?.path??'')}catch{}
        if(!frozenItem||item.sha256!==frozenItem.sha256||item.bytes!==frozenItem.bytes||graphSource!==frozenSource||
           item.publication_action!=='upload-as-page-attachment'||item.status!=='required-before-publication')
          failures.push(`${label}: publication graph attachment differs from the frozen file/action identity: ${node.id}/${item.filename}`);
      }
    }
  }

  const nodes = frozen.nodes ?? [];
  const themeNodes = nodes.filter(node => node.id?.startsWith('theme:'));
  if (frozen.inventory?.theme_nodes !== themeNodes.length || frozen.inventory?.shared_nodes !== nodes.length - themeNodes.length ||
      frozen.inventory?.total_nodes !== nodes.length || frozen.inventory?.edges !== (frozen.edges ?? []).length ||
      frozen.inventory?.attachments !== (frozen.attachments ?? []).length)
    failures.push(`${label}: frozen publication inventory counts do not match its nodes, dependencies, and attachments`);

  for (const node of nodes) {
    if (node.action === 'create' || node.action === 'update') {
      if (typeof node.publication_source !== 'string' || !node.publication_source) {
        failures.push(`${label}: publishable node lacks its exact source path: ${node.id}`);
      } else {
        try {
          const sourcePath = containedRelative(root, node.publication_source, `${node.id} publication source`, path.join(root, 'publication'));
          if (sha(fs.readFileSync(sourcePath)) !== node.source_sha256) failures.push(`${label}: publication source SHA differs from the frozen node: ${node.id}`);
          if (node.candidate_css_sha256) {
            const packageDirectory = path.dirname(sourcePath);
            const relativePackage = path.relative(path.join(root, 'ports'), packageDirectory);
            if (relativePackage.startsWith('..') || path.isAbsolute(relativePackage)) throw new Error('candidate CSS path is not under ports');
            const cssPath = containedRelative(root, 'candidate.css', `${node.id} candidate CSS`, packageDirectory);
            if (sha(fs.readFileSync(cssPath)) !== node.candidate_css_sha256) failures.push(`${label}: candidate CSS SHA differs from the frozen node: ${node.id}`);
          }
        } catch (error) {
          failures.push(`${label}: publication source/CSS is unavailable for ${node.id}: ${error.message}`);
        }
      }
    } else if (node.action === 'reuse-existing' && node.publication_source !== null) {
      failures.push(`${label}: reuse-existing node unexpectedly has a publication source: ${node.id}`);
    }

    if ((node.id?.startsWith('component:') || node.id?.startsWith('fragment:')) && node.action === 'reuse-existing') {
      const slug = node.id;
      const packageDirectory = path.join(root, 'publication', 'components', slug);
      const manifestPath = path.join(packageDirectory, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(containedRelative(root, path.relative(root, manifestPath), `${node.id} publication manifest`), 'utf8'));
          if (manifest.action !== 'reuse-existing' || manifest.source_sha256 !== node.source_sha256)
            failures.push(`${label}: reusable component manifest differs from the frozen authority: ${node.id}`);
          const sourceFile = manifest.source_file;
          if (sourceFile && sha(fs.readFileSync(containedRelative(root, sourceFile, `${node.id} current source`, packageDirectory))) !== node.source_sha256)
            failures.push(`${label}: reusable component source copy differs from current authority: ${node.id}`);
        } catch (error) {
          failures.push(`${label}: reusable component authority is invalid: ${node.id}: ${error.message}`);
        }
      }
    }
  }

  const authorityFiles = new Map();
  for (const artifact of frozen.authority?.artifacts ?? []) {
    try {
      const bytes = fs.readFileSync(containedRelative(root, artifact.path, `Frozen authority artifact ${artifact.id}`));
      if (sha(bytes) !== artifact.sha256) failures.push(`${label}: frozen authority artifact changed: ${artifact.id}`);
      authorityFiles.set(artifact.id, JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      failures.push(`${label}: frozen authority artifact is unavailable: ${artifact.id}: ${error.message}`);
    }
  }
  for (const edge of frozen.edges ?? []) {
    if (!edge.source_sha256) continue;
    const fromIds = String(edge.from ?? '').split('+');
    if (fromIds.length === 1) {
      const sourceNode = nodes.find(node => node.id === fromIds[0]);
      if (sourceNode && sourceNode.source_sha256 !== edge.source_sha256)
        failures.push(`${label}: actionable dependency source identity differs from its publication node: ${edge.from}`);
      const hasAuthority = [...authorityFiles.values()].some(document => authorityRecordContains(document, fromIds[0], edge.source_sha256));
      if (authorityFiles.size && !hasAuthority) failures.push(`${label}: actionable dependency source SHA is absent from current authority evidence: ${edge.from}`);
    }
  }
  for (const attachment of frozen.attachments ?? []) {
    try {
      if (path.basename(attachment.path ?? '') !== attachment.filename) throw new Error('attachment path filename differs from the publication filename');
      const bytes = fs.readFileSync(containedRelative(root, attachment.path, `${attachment.node} attachment ${attachment.filename}`));
      if (sha(bytes) !== attachment.sha256 || bytes.length !== attachment.bytes)
        failures.push(`${label}: attachment identity differs from the frozen publication inventory: ${attachment.node}/${attachment.filename}`);
    } catch (error) {
      failures.push(`${label}: attachment is unavailable: ${attachment.node}/${attachment.filename}: ${error.message}`);
    }
  }

  const readinessPath = frozen.readiness_audit;
  if (readinessPath) {
    const readiness = documents?.readiness ?? readJson(root, `publication/${readinessPath}`, 'Candidate freeze readiness audit', failures);
    if (readiness) {
      if (frozen.readiness_audit_sha256 !== sha(readiness.bytes)) failures.push(`${label}: frozen readiness audit whole-file SHA is stale`);
      if (readiness.value.freeze_record?.candidate_set_sha256 !== frozen.candidate_set_sha256 || readiness.value.freeze_record?.manifest_sha256)
        failures.push(`${label}: readiness audit does not use the stable candidate-set identity in a one-way freeze binding`);
    }
  }

  validateBhlTargetedEvidence(root, frozen, graphArtifact?.value, failures, scope);
  return failures;
}
