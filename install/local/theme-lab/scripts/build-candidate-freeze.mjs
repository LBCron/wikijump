#!/usr/bin/env node
// Regenerates publication/frozen-candidate-set.json and the candidate_freeze
// block of publication/dependency-graph.json from current repository bytes.
//
// Computed from bytes: node source and candidate.css hashes, attachment
// hashes, authority artifact hashes, the adaptation-ledger and source-audit
// cross-checks, the framerail and Deepwell identities, the visual-gate policy
// counts, the readiness binding, and the candidate-set identity (computed by
// frozenCandidateSetSha256 from src/publication-candidate-freeze.mjs).
//
// Carried from the committed files: declared node metadata (id, site, action,
// publication_source, upstream, current_jp_source, status), edges, targeted
// scenario definitions, acceptance state, the readiness audit path, and the
// generated_at date. Values that cannot be checked from repository bytes are
// listed as carried in the summary. They are never invented.
//
// Mismatches that would make validatePublicationCandidateSet reject the output
// are reported as findings (exit 1). --write still writes the output so that
// it can be inspected. The output is acceptable only with zero findings.
//
// Targeted BHL scenarios are checked against the authority bytes and the theme
// candidate hashes, so a stale scenario is a finding. The regenerated output is
// then validated by validatePublicationCandidateSet, using the in-memory files
// through its documents option. Its failures are reported with the findings and
// also make the run fail.
//
// --check compares the regenerated files with the committed files and exits 1
// on any difference. --write writes only the two regenerated files, into
// --output-dir (default: a scratch directory under os.tmpdir()). It never edits
// the committed files, so the caller must copy the output in explicitly.
// --source-dependency-audit PATH (checkout-relative) reads a successor audit
// in place of the committed one. Its path is recorded in the output.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {candidateIdentity} from '../ports/scripts/candidate-identity.mjs';
import {assertPublishablePackage} from '../src/adaptation-authority.mjs';
import {requireDeepwellRuntimeIdentity} from '../src/deepwell-runtime-identity.mjs';
import {framerailSourceFingerprintSyncMemoized} from '../src/framerail-source-fingerprint-memo.mjs';
import {resolveExistingContainedFile} from '../src/package-path.mjs';
import {frozenCandidateSetSha256, validatePublicationCandidateSet} from '../src/publication-candidate-freeze.mjs';

export const THEME_LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FROZEN_FILE = 'frozen-candidate-set.json';
export const GRAPH_FILE = 'dependency-graph.json';
const COMPONENT_PREFIXES = ['component:', 'fragment:'];
const REQUIRED_ARTIFACTS = ['adaptation-authority', 'bhl-option-authority', 'source-dependency-audit', 'foreign-dependency-policy-audit'];

export class CandidateFreezeError extends Error {}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const posix = relative => relative.split(path.sep).join('/');
const serialize = value => `${JSON.stringify(value, null, 2)}\n`;

function contained(root, relative, label, base = root) {
  try {
    return resolveExistingContainedFile(root, relative, label, base);
  } catch (error) {
    throw new CandidateFreezeError(`${label}: ${error.message}`);
  }
}

function readBytes(root, relative, label, base = root) {
  return fs.readFileSync(contained(root, relative, label, base));
}

function readJson(root, relative, label, base = root) {
  try {
    return JSON.parse(readBytes(root, relative, label, base).toString('utf8'));
  } catch (error) {
    if (error instanceof CandidateFreezeError) throw error;
    throw new CandidateFreezeError(`${label}: ${error.message}`);
  }
}

// Node identities are hashed from raw bytes, as the validator does. The CSS
// identity comes from candidateIdentity(), whose rawSha is the same value for
// UTF-8 input. Non-UTF-8 CSS is rejected rather than silently rehashed.
function cssSha(bytes, label) {
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
    throw new CandidateFreezeError(`${label}: candidate CSS is not valid UTF-8`);
  }
  const {rawSha} = candidateIdentity(bytes, '');
  if (rawSha !== sha256(bytes)) throw new CandidateFreezeError(`${label}: candidate CSS identity differs from its bytes`);
  return rawSha;
}

function addFinding(context, code, subject, message) {
  context.findings.push({code, subject, message});
}

// A graph hash field is rewritten only where the committed node already
// declares it, or where the value is non-null. This keeps the key set and key
// order of the committed graph.
function setDeclared(object, key, value) {
  if (Object.hasOwn(object, key) || value !== null) object[key] = value;
}

function sourceAuditShas(sourceAudit, id) {
  return [...new Set((sourceAudit.dependencies ?? [])
    .filter(entry => entry.slug === id)
    .flatMap(entry => (entry.observations ?? []).map(observation => observation.authority?.source_sha256))
    .filter(Boolean))];
}

// Returns the publication source hash plus, when the node has a package, the
// candidate.css hash. The package CSS is included only when a sibling file
// exists. A declared CSS hash without a file is an error. An undeclared file
// is a finding, because adding a candidate input changes the freeze.
function publicationNodeBytes(context, graphNode) {
  const {root, publication} = context;
  const id = graphNode.id;
  const label = `${id} publication source`;
  const sourcePath = contained(root, graphNode.publication_source, label, publication);
  const source = sha256(fs.readFileSync(sourcePath));
  const packageDirectory = path.dirname(sourcePath);
  const cssFile = path.join(packageDirectory, 'candidate.css');
  let css = null;
  if (fs.existsSync(cssFile)) {
    const relativePackage = path.relative(path.join(root, 'ports'), packageDirectory);
    if (relativePackage.startsWith('..') || path.isAbsolute(relativePackage)) {
      throw new CandidateFreezeError(`${id} candidate CSS is not under ports`);
    }
    css = cssSha(fs.readFileSync(contained(root, posix(path.relative(root, cssFile)), `${id} candidate CSS`)), `${id} candidate CSS`);
  }
  if (graphNode.candidate_css_sha256 && !css) throw new CandidateFreezeError(`${id} declares candidate CSS but no candidate.css exists`);
  if (!graphNode.candidate_css_sha256 && css) addFinding(context, 'css-undeclared', id, 'candidate.css exists for a node that declares no candidate CSS');
  return {source, css, origin: 'publication-source'};
}

// Reuse, retain, and cross-wiki nodes have no publication source. Their hash
// comes from a component publication manifest, or from the source-dependency
// audit's recorded current-page authority. Otherwise the declared value is
// carried, and the summary says so.
function sharedNodeSource(context, graphNode) {
  const {root, sourceAudit} = context;
  const id = graphNode.id;
  const prefix = COMPONENT_PREFIXES.find(candidate => id.startsWith(candidate));
  if (prefix) {
    const slug = id.slice(prefix.length);
    const manifestRelative = path.join('publication', 'components', slug, 'manifest.json');
    if (fs.existsSync(path.join(root, manifestRelative))) {
      const manifest = readJson(root, manifestRelative, `${id} publication manifest`);
      const sourceRelative = path.join('publication', 'components', slug, manifest.source_file ?? 'source.wikidot.txt');
      const actual = sha256(readBytes(root, sourceRelative, `${id} manifest source`));
      if (manifest.source_sha256 !== actual) addFinding(context, 'manifest-stale', id, 'component manifest source_sha256 differs from its source file');
      if (graphNode.source_sha256 && graphNode.source_sha256 !== actual) addFinding(context, 'declared-source-mismatch', id, 'declared source_sha256 differs from the component source file');
      return {source: actual, origin: 'component-manifest'};
    }
  }
  const observed = sourceAuditShas(sourceAudit, id);
  if (observed.length > 1) throw new CandidateFreezeError(`${id}: source-dependency audit records ${observed.length} different sources`);
  if (observed.length === 1) {
    if (graphNode.source_sha256 && graphNode.source_sha256 !== observed[0]) addFinding(context, 'declared-source-mismatch', id, 'declared source_sha256 differs from the source-dependency audit');
    return {source: observed[0], origin: 'source-dependency-audit'};
  }
  return {source: graphNode.source_sha256 ?? null, origin: 'carried'};
}

function buildNodes(context, graph) {
  return graph.nodes.map(graphNode => {
    const bytes = graphNode.publication_source ? publicationNodeBytes(context, graphNode) : null;
    const shared = bytes ? null : sharedNodeSource(context, graphNode);
    const source = bytes ? bytes.source : shared.source;
    const css = bytes ? bytes.css : null;
    if (shared?.origin === 'carried') context.carried.push(graphNode.id);
    if (graphNode.id.startsWith('theme:')) {
      const audit = context.sourceAudit.themes?.find(entry => entry.theme === graphNode.id);
      if (!audit) addFinding(context, 'audit-missing', graphNode.id, 'theme is absent from the source-dependency audit');
      else if (audit.candidate_source_sha256 !== source || (audit.candidate_css_sha256 ?? null) !== css) {
        addFinding(context, 'audit-stale', graphNode.id, 'source-dependency audit records different candidate hashes than current bytes');
      }
    }
    return {
      id: graphNode.id,
      site: graphNode.site ?? null,
      action: graphNode.action ?? null,
      publication_source: graphNode.publication_source ?? null,
      source_sha256: source,
      candidate_css_sha256: css,
      upstream: graphNode.upstream ?? null,
      current_jp_source: graphNode.current_jp_source ?? null,
      status: graphNode.status ?? null,
    };
  });
}

// Attachment declarations are carried from the graph. Their bytes are computed.
// The graph copy is updated in the same pass so that both files agree.
function buildAttachments(context, graph) {
  const attachments = [];
  for (const graphNode of graph.nodes) {
    for (const item of graphNode.attachments ?? []) {
      const label = `${graphNode.id} attachment ${item.filename}`;
      const actual = contained(context.root, item.source, label, context.publication);
      const bytes = fs.readFileSync(actual);
      item.sha256 = sha256(bytes);
      item.bytes = bytes.length;
      attachments.push({
        node: graphNode.id,
        filename: item.filename,
        path: posix(path.relative(context.root, path.resolve(context.publication, item.source))),
        sha256: item.sha256,
        bytes: item.bytes,
      });
    }
  }
  return attachments;
}

function buildAuthority(context, listed, ledger, bhl, framerail) {
  const artifacts = listed.map(({id, path: relative}) => ({
    id,
    path: relative,
    sha256: sha256(readBytes(context.root, relative, `Authority artifact ${id}`)),
  }));
  const byId = Object.fromEntries(artifacts.map(artifact => [artifact.id, artifact.sha256]));
  for (const id of REQUIRED_ARTIFACTS) {
    if (!(id in byId)) throw new CandidateFreezeError(`Committed freeze does not list the authority artifact ${id}`);
  }
  const bhlIdentity = requireDeepwellRuntimeIdentity(bhl.backend_runtime_identity, 'BHL option authority').identity_sha256;
  if (bhl.framerail?.fingerprint_sha256 !== framerail) {
    addFinding(context, 'bhl-framerail-stale', 'bhl-option-authority',
      `BHL option authority pins framerail ${bhl.framerail?.fingerprint_sha256} but this checkout computes ${framerail}`);
  }
  context.carried.push('authority.bhl_backend_runtime_identity_sha256 (recorded in the BHL option authority; not checked against a running container)');
  return {
    adaptation_authority_packages: Object.keys(ledger.packages ?? {}).length,
    adaptation_authority_sha256: byId['adaptation-authority'],
    bhl_option_authority_sha256: byId['bhl-option-authority'],
    bhl_framerail_fingerprint_sha256: framerail,
    source_dependency_audit_sha256: byId['source-dependency-audit'],
    foreign_dependency_policy_audit_sha256: byId['foreign-dependency-policy-audit'],
    artifacts,
    bhl_backend_runtime_identity_sha256: bhlIdentity,
  };
}

// Opt-in: runs the same per-package check as ports/scripts/check-adaptation-authority.mjs.
// It needs the local authority evidence (checkout or shared cache), so it is
// not part of the default offline run.
function checkAdaptationAuthority(context) {
  const ledger = readJson(context.root, path.join('ports', 'adaptation-authority.json'), 'Adaptation authority ledger');
  for (const name of Object.keys(ledger.packages ?? {})) {
    try {
      assertPublishablePackage(name, {checkOutputs: true, portsRoot: path.join(context.root, 'ports')});
    } catch (error) {
      addFinding(context, 'adaptation-authority-failed', name, error.message);
    }
  }
}

// The adaptation ledger records candidate.css and candidate source hashes for
// each ports package. It applies only to a node whose publication source is
// that same package. A publication package that differs from its ports
// package (for example the quand theme) is not compared.
function checkLedger(context, ledger, nodes) {
  for (const node of nodes) {
    if (!node.id.startsWith('theme:') || !node.publication_source) continue;
    const name = node.id.slice('theme:'.length);
    if (!node.publication_source.startsWith(`../ports/${name}/`)) continue;
    const entry = ledger.packages?.[name];
    if (!entry?.outputs) continue;
    if (entry.outputs['candidate.wikidot.source.txt'] && entry.outputs['candidate.wikidot.source.txt'] !== node.source_sha256) {
      addFinding(context, 'ledger-stale', node.id, 'adaptation ledger source output differs from current source bytes');
    }
    if (entry.outputs['candidate.css'] && entry.outputs['candidate.css'] !== node.candidate_css_sha256) {
      addFinding(context, 'ledger-stale', node.id, 'adaptation ledger candidate.css output differs from current CSS bytes');
    }
  }
}

function gateCounts(policy) {
  const counts = {V: 0, C: 0, M: 0};
  for (const row of policy.rows ?? []) {
    if (!(row.class in counts)) throw new CandidateFreezeError(`visual policy row ${row.index} has an unknown class`);
    counts[row.class] += 1;
  }
  return counts;
}

// Targeted receipts and visual reviews bind the candidate-set identity and the
// framerail fingerprint. A regenerated identity therefore leaves them stale
// until they are captured again. Absent files give a null hash, not a guess.
function buildTargetedEvidence(context, scenarios, candidateSetSha, framerail) {
  const bind = (relative, label) => {
    if (!fs.existsSync(path.join(context.root, relative))) {
      addFinding(context, 'targeted-evidence-missing', label, `${relative} is absent from this checkout`);
      return null;
    }
    const bytes = readBytes(context.root, relative, label);
    const document = JSON.parse(bytes.toString('utf8'));
    if (document.candidate_set_sha256 !== candidateSetSha) {
      addFinding(context, 'targeted-evidence-stale', label, `${relative} is bound to a different candidate set`);
    }
    if (document.framerail_fingerprint_sha256 !== framerail) {
      addFinding(context, 'targeted-evidence-stale', label, `${relative} is bound to a different framerail fingerprint`);
    }
    return sha256(bytes);
  };
  return scenarios.map(scenario => ({
    scenario_id: scenario.id,
    visual_review: {path: scenario.visual_review, sha256: bind(scenario.visual_review, `${scenario.id} visual review`)},
    receipts: (scenario.receipt_evidence ?? []).map(receipt => ({path: receipt, sha256: bind(receipt, `${scenario.id} receipt`)})),
  }));
}

// Pure generation. Returns the regenerated text, the findings, and the
// fields carried without byte evidence. It does not write anything.
// readinessDocument, when given as {bytes, value}, replaces the readiness file
// on disk. build-readiness-audit.mjs uses it to validate a file that is not written yet.
export function buildCandidateFreeze({root = THEME_LAB, generatedAt = null, readinessAudit = null, readinessDocument = null, expectFramerailFingerprint = null, verifyAdaptationAuthority = false, sourceDependencyAudit = null} = {}) {
  const committedFrozen = readJson(root, path.join('publication', FROZEN_FILE), 'Committed frozen candidate set');
  const committedGraph = readJson(root, path.join('publication', GRAPH_FILE), 'Committed publication dependency graph');
  const publication = path.join(root, 'publication');
  const repoRoot = path.resolve(root, '../../..');
  const generated = generatedAt ?? committedFrozen.generated_at;
  if (Number.isNaN(Date.parse(generated))) throw new CandidateFreezeError(`generated_at is not a date: ${generated}`);
  const context = {root, publication, sourceAudit: null, findings: [], carried: []};

  const listedArtifacts = (committedFrozen.authority?.artifacts ?? []).map(artifact =>
    artifact.id === 'source-dependency-audit' && sourceDependencyAudit ? {...artifact, path: sourceDependencyAudit} : artifact);
  const artifactPath = id => {
    const entry = listedArtifacts.find(artifact => artifact.id === id);
    if (!entry) throw new CandidateFreezeError(`Committed freeze does not list the authority artifact ${id}`);
    return entry.path;
  };
  const ledger = readJson(root, artifactPath('adaptation-authority'), 'Adaptation authority ledger');
  const bhl = readJson(root, artifactPath('bhl-option-authority'), 'BHL option authority');
  context.sourceAudit = readJson(root, artifactPath('source-dependency-audit'), 'Source-dependency audit');

  const framerail = framerailSourceFingerprintSyncMemoized(repoRoot);
  if (expectFramerailFingerprint && expectFramerailFingerprint !== framerail) {
    addFinding(context, 'expected-framerail-mismatch', 'framerail', `expected ${expectFramerailFingerprint} but this checkout computes ${framerail}`);
  }

  const nodes = buildNodes(context, committedGraph);
  checkLedger(context, ledger, nodes);
  if (verifyAdaptationAuthority) checkAdaptationAuthority(context);
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const attachments = buildAttachments(context, committedGraph);
  const edges = structuredClone(committedGraph.edges ?? []);
  const targetedScenarios = structuredClone(committedGraph.targeted_scenarios ?? []);

  for (const edge of edges) {
    if (!edge.source_sha256 || String(edge.from).includes('+')) continue;
    const node = nodesById.get(edge.from);
    if (node && node.source_sha256 !== edge.source_sha256) addFinding(context, 'edge-source-stale', edge.from, 'dependency edge source_sha256 differs from its node');
  }
  for (const scenario of targetedScenarios) {
    const candidate = scenario.source_candidate;
    if (candidate && nodesById.get(candidate.slug)?.source_sha256 !== candidate.source_sha256) {
      addFinding(context, 'scenario-source-stale', scenario.id, `targeted scenario pins ${candidate.slug} source ${candidate.source_sha256}`);
    }
  }

  const themeNodes = nodes.filter(node => node.id.startsWith('theme:')).length;
  const inventory = {theme_nodes: themeNodes, shared_nodes: nodes.length - themeNodes, total_nodes: nodes.length, edges: edges.length, attachments: attachments.length};
  const authority = buildAuthority(context, listedArtifacts, ledger, bhl, framerail);
  for (const scenario of targetedScenarios) {
    if (Object.hasOwn(scenario, 'current_authority_sha256') && scenario.current_authority_sha256 !== authority.bhl_option_authority_sha256) {
      addFinding(context, 'scenario-authority-stale', scenario.id, `targeted scenario pins BHL option authority ${scenario.current_authority_sha256}; current bytes are ${authority.bhl_option_authority_sha256}`);
    }
    if (Object.hasOwn(scenario, 'theme_candidate_source_sha256') || Object.hasOwn(scenario, 'theme_candidate_css_sha256')) {
      const themeNode = nodesById.get(scenario.theme ?? 'theme:black-highlighter-theme');
      if (scenario.theme_candidate_source_sha256 !== (themeNode?.source_sha256 ?? null) || scenario.theme_candidate_css_sha256 !== (themeNode?.candidate_css_sha256 ?? null)) {
        addFinding(context, 'scenario-candidate-stale', scenario.id, `targeted scenario pins a theme candidate that differs from the current ${themeNode?.id ?? 'theme'} bytes`);
      }
    }
  }

  const readinessRelative = readinessAudit ?? committedFrozen.readiness_audit;
  const readinessBytes = readinessDocument ? readinessDocument.bytes : readBytes(root, readinessRelative, 'Readiness audit', publication);
  const readiness = readinessDocument ? readinessDocument.value : JSON.parse(readinessBytes.toString('utf8'));
  const readinessSha = sha256(readinessBytes);

  const gateCommitted = committedFrozen['145_state_visual_gate'] ?? {};
  const policyBytes = readBytes(root, gateCommitted.policy, '145-state visual gate policy', publication);
  const policy = JSON.parse(policyBytes.toString('utf8'));
  const counts = gateCounts(policy);
  if (policy.counts && (policy.counts.V !== counts.V || policy.counts.C !== counts.C || policy.counts.M !== counts.M)) {
    addFinding(context, 'visual-policy-counts-mismatch', 'visual-gate-policy', 'policy counts differ from its rows');
  }
  const implementationBytes = readBytes(root, gateCommitted.implementation_audit, '145-state visual gate implementation audit', publication);

  const identityFields = {
    schema: committedFrozen.schema,
    generated_at: generated,
    inventory,
    nodes,
    edges,
    attachments,
    targeted_scenarios: targetedScenarios,
    authority,
    state: committedFrozen.state,
    readiness_audit: readinessRelative,
    final_acceptance: committedFrozen.final_acceptance,
    '145_state_visual_gate': {
      status: gateCommitted.status,
      policy: gateCommitted.policy,
      policy_sha256: sha256(policyBytes),
      counts,
      implementation_audit: gateCommitted.implementation_audit,
      implementation_audit_sha256: sha256(implementationBytes),
    },
    identity_contract: committedFrozen.identity_contract,
  };
  const candidateSetSha = frozenCandidateSetSha256(identityFields);
  if (readiness.freeze_record?.candidate_set_sha256 !== candidateSetSha) {
    addFinding(context, 'readiness-binding-stale', readinessRelative, 'readiness audit freeze_record binds a different candidate set');
  }

  const frozen = {
    schema: identityFields.schema,
    generated_at: identityFields.generated_at,
    inventory,
    nodes,
    edges,
    attachments,
    targeted_scenarios: targetedScenarios,
    authority,
    state: identityFields.state,
    readiness_audit: readinessRelative,
    final_acceptance: identityFields.final_acceptance,
    '145_state_visual_gate': identityFields['145_state_visual_gate'],
    identity_contract: identityFields.identity_contract,
    candidate_set_sha256: candidateSetSha,
    targeted_evidence_bindings: buildTargetedEvidence(context, targetedScenarios, candidateSetSha, framerail),
    readiness_audit_sha256: readinessSha,
  };

  const graph = structuredClone(committedGraph);
  if (generatedAt) graph.generated_at = generated.slice(0, 10);
  graph.nodes.forEach((graphNode, index) => {
    setDeclared(graphNode, 'source_sha256', nodes[index].source_sha256);
    setDeclared(graphNode, 'candidate_css_sha256', nodes[index].candidate_css_sha256);
  });
  graph.candidate_freeze = {
    path: committedGraph.candidate_freeze?.path ?? FROZEN_FILE,
    candidate_set_sha256: candidateSetSha,
    state: frozen.state,
    frozen_at: generatedAt ? generated.slice(0, 10) : committedGraph.candidate_freeze?.frozen_at,
    readiness_audit_sha256: readinessSha,
  };

  // Self-check: the written text must pass the same validator the campaign uses.
  // The in-memory text is re-parsed so the validator sees exactly the bytes that
  // would be written.
  const frozenText = serialize(frozen);
  const graphText = serialize(graph);
  const validation = validatePublicationCandidateSet(root, {
    documents: {frozen: {value: JSON.parse(frozenText)}, graph: {value: JSON.parse(graphText)}, readiness: {bytes: readinessBytes, value: readiness}},
  });

  return {
    frozen,
    graph,
    frozenText,
    graphText,
    candidateSetSha256: candidateSetSha,
    committedCandidateSetSha256: committedFrozen.candidate_set_sha256,
    findings: context.findings,
    validation,
    carried: context.carried,
  };
}

// Field-level differences, labelled by node or attachment identity where the
// array element carries one.
export function diffValues(before, after, pathLabel = '', out = []) {
  if (before === after) return out;
  const bothObjects = before && after && typeof before === 'object' && typeof after === 'object';
  if (!bothObjects || Array.isArray(before) !== Array.isArray(after)) {
    out.push(pathLabel || '$');
    return out;
  }
  if (Array.isArray(before)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const label = after[index]?.id ?? before[index]?.id ?? (after[index]?.node && after[index]?.filename ? `${after[index].node}/${after[index].filename}` : index);
      diffValues(before[index], after[index], `${pathLabel}[${label}]`, out);
    }
    return out;
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    diffValues(before[key], after[key], pathLabel ? `${pathLabel}.${key}` : key, out);
  }
  return out;
}

function parseArguments(argv) {
  const options = {mode: null, root: THEME_LAB, outputDir: null, generatedAt: null, readinessAudit: null, expectFramerailFingerprint: null, verifyAdaptationAuthority: false, sourceDependencyAudit: null};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new CandidateFreezeError(`${argument} requires a value`);
      index += 1;
      return next;
    };
    if (argument === '--check' || argument === '--write') {
      if (options.mode) throw new CandidateFreezeError('choose exactly one of --check or --write');
      options.mode = argument.slice(2);
    } else if (argument === '--root') options.root = path.resolve(value());
    else if (argument === '--output-dir') options.outputDir = path.resolve(value());
    else if (argument === '--generated-at') options.generatedAt = value();
    else if (argument === '--readiness-audit') options.readinessAudit = value();
    else if (argument === '--expect-framerail-fingerprint') options.expectFramerailFingerprint = value();
    else if (argument === '--verify-adaptation-authority') options.verifyAdaptationAuthority = true;
    else if (argument === '--source-dependency-audit') options.sourceDependencyAudit = value();
    else throw new CandidateFreezeError(`unknown argument: ${argument}`);
  }
  if (!options.mode) throw new CandidateFreezeError('usage: build-candidate-freeze.mjs (--check | --write [--output-dir DIR]) [--root DIR] [--generated-at ISO] [--readiness-audit PUBLICATION_RELATIVE] [--source-dependency-audit ROOT_RELATIVE] [--expect-framerail-fingerprint SHA256] [--verify-adaptation-authority]');
  if (options.outputDir && options.mode !== 'write') throw new CandidateFreezeError('--output-dir is only valid with --write');
  if (options.expectFramerailFingerprint && !/^[a-f0-9]{64}$/u.test(options.expectFramerailFingerprint)) {
    throw new CandidateFreezeError('--expect-framerail-fingerprint must be a 64-character lowercase SHA-256');
  }
  return options;
}

function printFindings(findings, log) {
  for (const item of findings) log(`  finding ${item.code} ${item.subject}: ${item.message}`);
}

function printValidation(failures, log) {
  for (const failure of failures) log(`  finding validatePublicationCandidateSet: ${failure}`);
}

export function main(argv = process.argv.slice(2), {log = console.log, error = console.error} = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (failure) {
    error(failure.message);
    return 2;
  }
  let result;
  try {
    result = buildCandidateFreeze({
      root: options.root,
      generatedAt: options.generatedAt,
      readinessAudit: options.readinessAudit,
      expectFramerailFingerprint: options.expectFramerailFingerprint,
      verifyAdaptationAuthority: options.verifyAdaptationAuthority,
      sourceDependencyAudit: options.sourceDependencyAudit,
    });
  } catch (failure) {
    error(`candidate freeze generation failed: ${failure.message}`);
    return 2;
  }
  const publication = path.join(options.root, 'publication');
  log(`candidate_set_sha256 ${result.candidateSetSha256}`);
  log(`committed candidate_set_sha256 ${result.committedCandidateSetSha256}`);
  log(`carried without byte evidence: ${result.carried.length} (${result.carried.join(', ')})`);

  if (options.mode === 'check') {
    const committedFrozen = fs.readFileSync(path.join(publication, FROZEN_FILE), 'utf8');
    const committedGraph = fs.readFileSync(path.join(publication, GRAPH_FILE), 'utf8');
    const differences = [];
    if (committedFrozen !== result.frozenText) {
      differences.push(...diffValues(JSON.parse(committedFrozen), result.frozen).map(field => `${FROZEN_FILE}: ${field}`));
    }
    if (committedGraph !== result.graphText) {
      differences.push(...diffValues(JSON.parse(committedGraph), result.graph).map(field => `${GRAPH_FILE}: ${field}`));
    }
    for (const field of differences) log(`  differs ${field}`);
    printFindings(result.findings, log);
    printValidation(result.validation, log);
    const ok = differences.length === 0 && result.findings.length === 0 && result.validation.length === 0;
    log(ok ? 'check: pass' : `check: fail (${differences.length} differing fields, ${result.findings.length} findings, ${result.validation.length} validator failures)`);
    return ok ? 0 : 1;
  }

  const outputDir = options.outputDir ?? path.join(os.tmpdir(), 'wikijump-theme-lab-candidate-freeze');
  fs.mkdirSync(outputDir, {recursive: true});
  fs.writeFileSync(path.join(outputDir, FROZEN_FILE), result.frozenText);
  fs.writeFileSync(path.join(outputDir, GRAPH_FILE), result.graphText);
  log(`wrote ${path.join(outputDir, FROZEN_FILE)}`);
  log(`wrote ${path.join(outputDir, GRAPH_FILE)}`);
  printFindings(result.findings, log);
  printValidation(result.validation, log);
  if (result.findings.length || result.validation.length) {
    log(`not acceptable: ${result.findings.length} findings and ${result.validation.length} validator failures must be resolved before this freeze can validate`);
    return 1;
  }
  log('no findings');
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}
