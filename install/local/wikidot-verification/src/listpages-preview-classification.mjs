import fs from "node:fs/promises";

import {
  canonicalDom,
  sha256,
  validateWikidotReference,
  visibleText,
} from "./syntax-differential.mjs";
import {localVisibleText} from "./local-output-comparison.mjs";
import {
  descendantElements,
  nodeAttribute,
  nodeHasClass,
  nodeText,
  normalizeCanonicalFootnoteNonces,
  normalizeSynchronizedComposedLinkedTitles,
  normalizeSynchronizedFirstImageFixture,
  normalizeSynchronizedImportedFileOrigins,
  normalizeSynchronizedImportedPageExistence,
  normalizeSynchronizedLinkedTitleSpaces,
  normalizeSynchronizedLinkedTitleTypography,
  normalizeSynchronizedRuntimeFixtures,
  synchronizedImportedAuthorNames,
} from "./listpages-preview-classification/runtime-normalization.mjs";
import {
  compareListPagesPreviewHtml,
  LISTPAGES_PREVIEW_DIFFERENTIAL_SCHEMA,
  validateListPagesRuntimeIdentity,
  validateListPagesRuntimeProof,
} from "./listpages-preview-differential.mjs";
import {
  extractListPagesInvocationsFromSource,
} from "./listpages-campaign-inventory.mjs";
import {
  publishListPagesJsonNoReplace,
} from "./listpages-evidence-publication.mjs";
import {
  observeListPagesRuntimeAuthority,
  validateListPagesRuntimeObservation,
} from "./listpages-runtime-authority.mjs";
import {
  compareTabviewSafetyPreservation,
} from "./generic-runtime-differential.mjs";

export const LISTPAGES_PREVIEW_CLASSIFICATION_SCHEMA =
  "wikijump_listpages_compat.preview_classification.v1";

function readJsonlText(text) {
  if (!text.trim()) return [];
  return text.trimEnd().split(/\r?\n/u).map((line) => JSON.parse(line));
}

function domHasClass(nodes, className) {
  for (const node of nodes ?? []) {
    const classes = node.attrs
      ?.find((attribute) => attribute.name === "class")
      ?.value.split(/\s+/u) ?? [];
    if (classes.includes(className) || domHasClass(node.children, className)) {
      return true;
    }
  }
  return false;
}

function localDom(row) {
  if (row.comparison?.checks?.dom_tree?.status === "mismatch") {
    return row.comparison.checks.dom_tree.local;
  }
  return null;
}

function hasExactPagePreviewTransportWhitespace({
  row,
  reference,
  liveNodes,
  localNodes,
}) {
  if (
    reference.provenance.module !== "edit/PagePreviewModule" ||
    typeof row.local?.raw_html !== "string" ||
    row.live.visible_text !== row.local.visible_text ||
    liveNodes.length < 3 ||
    liveNodes.length !== localNodes.length
  ) {
    return false;
  }
  const liveFirst = liveNodes[0];
  const localFirst = localNodes[0];
  const liveLast = liveNodes.at(-1);
  const localLast = localNodes.at(-1);
  if (
    liveFirst?.type !== "text" ||
    localFirst?.type !== "text" ||
    liveLast?.type !== "text" ||
    localLast?.type !== "text" ||
    !localFirst.value.startsWith("\n\n") ||
    liveFirst.value !== `\n\n    \n\n${localFirst.value.slice(2)}` ||
    liveLast.value !== `${localLast.value}\n    \n    \n    \n    `
  ) {
    return false;
  }
  return JSON.stringify(liveNodes.slice(1, -1)) ===
    JSON.stringify(localNodes.slice(1, -1));
}

function bareDefaultListPagesFixtureShape(nodes) {
  if (
    nodes.length !== 1 ||
    nodes[0]?.type !== "element" ||
    !nodeHasClass(nodes[0], "list-pages-box")
  ) {
    return null;
  }
  const wrapper = nodes[0];
  const children = wrapper.children ?? [];
  if (children.some((node) => node.type !== "element")) return null;
  const rows = children.filter((node) => nodeHasClass(node, "list-pages-item"));
  const pagers = children.filter((node) => nodeHasClass(node, "pager"));
  if (
    rows.length === 0 ||
    rows.length > 20 ||
    rows.length + pagers.length !== children.length ||
    pagers.length > 1 ||
    (pagers.length === 1 &&
      (rows.length !== 20 || children.at(-1) !== pagers[0])) ||
    descendantElements(
      wrapper,
      (node) => nodeHasClass(node, "list-pages-item"),
    ).length !== rows.length
  ) {
    return null;
  }
  const timestamps = [];
  const links = [];
  for (const row of rows) {
    const elements = (row.children ?? []).filter((node) => node.type === "element");
    if (elements.length !== 3 || descendantElements(row, (node) =>
      ["script", "iframe", "object", "embed"].includes(node.name) ||
      (node.attrs ?? []).some((attribute) =>
        /^on/iu.test(attribute.name) ||
        ((attribute.name === "href" || attribute.name === "src") && !attribute.value.startsWith("/")),
      ),
    ).length > 0) {
      return null;
    }
    const heading = elements[0];
    const byline = elements[1];
    const headingLinks = descendantElements(
      heading,
      (node) => node.name === "a" && nodeAttribute(node, "href") !== null,
    );
    const dates = descendantElements(
      byline,
      (node) => nodeHasClass(node, "odate"),
    );
    const timestamp = dates.length === 1
      ? /(?:^|\s)time_([0-9]+)(?:\s|$)/u.exec(nodeAttribute(dates[0], "class") ?? "")
      : null;
    if (
      heading?.name !== "h1" ||
      byline?.name !== "p" ||
      headingLinks.length !== 1 ||
      !nodeText(byline).startsWith("by ") ||
      nodeText(byline).trim().length <=
        3 + (dates.length === 1 ? nodeText(dates[0]).trim().length : 0) ||
      timestamp === null
    ) {
      return null;
    }
    links.push(nodeAttribute(headingLinks[0], "href"));
    timestamps.push(Number(timestamp[1]));
  }
  if (
    new Set(links).size !== links.length ||
    timestamps.some((timestamp, index) =>
      index > 0 && timestamps[index - 1] < timestamp
    )
  ) {
    return null;
  }
  return { links: new Set(links), pagers: pagers.length, rows: rows.length };
}

function hasBareDefaultListPagesFixtureState({ source, liveNodes, localNodes }) {
  if (source !== "[[module ListPages]]") return false;
  const live = bareDefaultListPagesFixtureShape(liveNodes);
  const local = bareDefaultListPagesFixtureShape(localNodes);
  if (
    live === null ||
    local === null ||
    live.pagers !== 1 ||
    local.pagers !== 0 ||
    live.rows !== 20 ||
    local.rows >= 20
  ) {
    return false;
  }
  return [...live.links].every((link) => !local.links.has(link));
}

function literalContextKeepsListPagesInactive({
  row,
  reference,
  localNodes,
  localUnsupportedDiagnostic,
}) {
  if (!row.case_id.endsWith(":literal-context")) return false;
  const liveNodes = canonicalDom(reference.raw_html);
  const liveExecuted = ["list-pages-box", "list-pages-item", "pager"]
    .some((className) => domHasClass(liveNodes, className));
  const localExecuted = ["list-pages-box", "list-pages-item", "pager"]
    .some((className) => domHasClass(localNodes, className));
  return !liveExecuted && !localExecuted && !localUnsupportedDiagnostic;
}

function outermostListPagesOwnedSubtrees(nodes) {
  const output = [];
  const ownedClasses = new Set([
    "list-pages-box",
    "list-pages-item",
    "pager",
  ]);
  const visit = (node) => {
    if (node?.type !== "element") return;
    const classes = node.attrs
      ?.find((attribute) => attribute.name === "class")
      ?.value.split(/\s+/u) ?? [];
    if (classes.some((className) => ownedClasses.has(className))) {
      output.push(node);
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes ?? []) visit(node);
  return output;
}

function normalizeListPagesOwnedWhitespace(node, preserveWhitespace = false) {
  if (node?.type === "text") {
    return !preserveWhitespace && node.value.trim() === "" ? null : { ...node };
  }
  if (node?.type !== "element") return node === undefined ? null : { ...node };
  const preserveChildren = preserveWhitespace || ["code", "pre", "textarea"].includes(node.name);
  return {
    ...node,
    children: (node.children ?? [])
      .map((child) => normalizeListPagesOwnedWhitespace(child, preserveChildren))
      .filter((child) => child !== null),
  };
}

function listPagesOwnedSubtreesEqual(liveNodes, localNodes) {
  return JSON.stringify(
    liveNodes.map(normalizeListPagesOwnedWhitespace),
  ) === JSON.stringify(
    localNodes.map(normalizeListPagesOwnedWhitespace),
  );
}

function literalContextHasExactListPagesExecution({
  row,
  liveNodes,
  localNodes,
  localUnsupportedDiagnostic,
}) {
  if (
    !row.case_id.endsWith(":literal-context") ||
    localUnsupportedDiagnostic
  ) {
    return false;
  }
  const liveOwned = outermostListPagesOwnedSubtrees(liveNodes);
  const localOwned = outermostListPagesOwnedSubtrees(localNodes);
  return liveOwned.length > 0 &&
    listPagesOwnedSubtreesEqual(liveOwned, localOwned);
}

function asciiCaseInsensitiveOccurrenceCount(text, needle) {
  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  let count = 0;
  let cursor = 0;
  while (target.length > 0) {
    const next = haystack.indexOf(target, cursor);
    if (next < 0) break;
    count += 1;
    cursor = next + target.length;
  }
  return count;
}

function literalDocumentationKeepsListPagesInactive({
  source,
  liveText,
  localText,
  liveNodes,
  localNodes,
  localUnsupportedDiagnostic,
}) {
  const stickyDocumentation =
    /^\[\[module[ \t]+listpages\]\]@@\r?\n@@\[\[div\b/iu.test(source);
  const inlineDocumentation =
    /^\[\[module[ \t]+listpages\]\](?:\}\}|@@\}\}|@@[^\r\n]{0,64}@@\[\[html\]\])/iu
      .test(source);
  if (
    localUnsupportedDiagnostic ||
    (!stickyDocumentation && !inlineDocumentation) ||
    (stickyDocumentation && liveText !== localText)
  ) {
    return false;
  }
  const ownedClasses = ["list-pages-box", "list-pages-item", "pager"];
  if (
    ownedClasses.some((className) =>
      domHasClass(liveNodes, className) || domHasClass(localNodes, className)
    )
  ) {
    return false;
  }
  const openings =
    source.match(/\[\[module[ \t]+listpages(?:[ \t][^\r\n\]]*)?\]\]/giu) ??
      [];
  if (openings.length === 0) return false;
  const openingCounts = new Map();
  for (const opening of openings) {
    const key = opening.toLowerCase();
    openingCounts.set(key, (openingCounts.get(key) ?? 0) + 1);
  }
  return [...openingCounts].every(([opening, count]) =>
    asciiCaseInsensitiveOccurrenceCount(liveText, opening) >= count &&
    asciiCaseInsensitiveOccurrenceCount(localText, opening) >= count
  );
}

function hasExactListPagesOwnedExecution({
  invocations,
  liveNodes,
  localNodes,
  localUnsupportedDiagnostic,
}) {
  if (
    localUnsupportedDiagnostic ||
    !Array.isArray(invocations) ||
    invocations.length === 0 ||
    invocations.some((candidate) =>
      candidate.execution_context !== "executable" ||
      invocationExpectsWrapper(candidate) !== true ||
      /\bclass\s*=\s*["'][^"']*\blist-pages-box\b/iu.test(candidate.body)
    ) ||
    (invocations.length > 1 && invocations.some((candidate) =>
      candidate.balanced !== true
    ))
  ) return false;
  const liveOwned = outermostListPagesOwnedSubtrees(liveNodes);
  const localOwned = outermostListPagesOwnedSubtrees(localNodes);
  return liveOwned.length > 0 &&
    listPagesOwnedSubtreesEqual(liveOwned, localOwned);
}


function templateVariables(source) {
  return [...source.matchAll(/%%[A-Za-z0-9_]+%%/gu)]
    .map((match) => match[0]);
}

function resolvesTemplateVariables(source, visibleText) {
  const variables = templateVariables(source);
  return variables.length > 0 &&
    variables.every((variable) => !visibleText.includes(variable));
}

function missingVisibleLineArgument(source, liveText, localText) {
  const invocations = extractListPagesInvocationsFromSource({
    branch: "classification",
    pageFullname: "preview",
    sourcePath: "preview",
    source,
  });
  return invocations
    .flatMap((invocation) => invocation.attributes ?? [])
    .filter((attribute) =>
      ["prependline", "appendline"].includes(attribute.name.toLowerCase())
    )
    .map((attribute) => attribute.value)
    .find((value) =>
      value.length > 0 &&
      liveText.includes(value) &&
      !localText.includes(value)
    ) ?? null;
}


function topLevelNodesWithClass(nodes, className) {
  return (nodes ?? []).filter((node) =>
    node.type === "element" && nodeHasClass(node, className)
  );
}

function exactSingleInvocation(source) {
  const invocations = extractListPagesInvocationsFromSource({
    branch: "classification",
    pageFullname: "preview",
    sourcePath: "preview",
    source,
  });
  if (
    invocations.length !== 1 ||
    invocations[0].source.trim() !== source.trim()
  ) {
    return null;
  }
  return invocations[0];
}

function oneArgumentValue(invocation, name) {
  const values = invocation.attributes
    .filter((attribute) => attribute.name.toLowerCase() === name)
    .map((attribute) => attribute.value);
  return values.length <= 1 ? (values[0] ?? null) : undefined;
}

function lastArgumentValue(invocation, name) {
  return invocation.attributes
    .filter((attribute) => attribute.name.toLowerCase() === name)
    .map((attribute) => attribute.value)
    .at(-1) ?? null;
}

function invocationExpectsWrapper(invocation) {
  const value = oneArgumentValue(invocation, "wrapper");
  if (value === undefined) return null;
  return !["no", "false"].includes(value?.trim().toLowerCase() ?? "");
}

function invocationUsesCombinedSections(invocation) {
  const value = oneArgumentValue(invocation, "separate");
  return value !== undefined &&
    ["no", "false"].includes(value?.trim().toLowerCase() ?? "");
}

function canonicalNodeLines(node) {
  const tokens = [];
  const blockNames = new Set([
    "p",
    "div",
    "blockquote",
    "li",
    "dt",
    "dd",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "tr",
    "td",
    "th",
    "pre",
  ]);
  const pushBreak = () => {
    if (tokens.at(-1) !== "\n") tokens.push("\n");
  };
  const visit = (current) => {
    if (current?.type === "text") {
      tokens.push(current.value);
      return;
    }
    if (current?.type !== "element") return;
    if (current.name === "br") {
      pushBreak();
      return;
    }
    const block = blockNames.has(current.name);
    if (block) pushBreak();
    for (const child of current.children ?? []) visit(child);
    if (block) pushBreak();
  };
  visit(node);
  return tokens
    .join("")
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
}

function plainSectionTemplates(invocation) {
  const sections = new Map();
  for (const match of invocation.body.matchAll(
    /\[\[(head|body|foot)\]\]([\s\S]*?)\[\[\/\1\]\]/giu,
  )) {
    sections.set(match[1].toLowerCase(), match[2]);
  }
  return sections;
}

function plainSectionText(source) {
  if (/\[\[|\]\]|%%|@@|@<|\{\{|\}\}/u.test(source)) return null;
  const text = source.replace(/\s+/gu, " ").trim();
  return text || null;
}

function plainBodyAnchor(source) {
  if (/\[\[|\]\]|@@|@<|\{\{|\}\}/u.test(source)) return null;
  const text = source
    .replace(/%%[A-Za-z0-9_]+%%/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length >= 3 ? text : null;
}

function missingPlainAuthoredSection({
  invocation,
  liveWrapper,
  localWrapper,
}) {
  if (!invocationUsesCombinedSections(invocation)) return null;
  const sections = plainSectionTemplates(invocation);
  const bodyAnchor = plainBodyAnchor(sections.get("body") ?? "");
  const liveLines = canonicalNodeLines(liveWrapper);
  const localLines = canonicalNodeLines(localWrapper);
  const liveBodyIndices = bodyAnchor === null
    ? []
    : liveLines.flatMap((line, index) =>
        line.includes(bodyAnchor) ? [index] : []
      );
  const localBodyIndices = bodyAnchor === null
    ? []
    : localLines.flatMap((line, index) =>
        line.includes(bodyAnchor) ? [index] : []
      );

  for (const section of ["head", "foot"]) {
    const authored = plainSectionText(sections.get(section) ?? "");
    if (authored === null) continue;
    const liveIndices = liveLines.flatMap((line, index) =>
      line === authored ? [index] : []
    );
    if (liveIndices.length === 0) continue;
    const localIndices = localLines.flatMap((line, index) =>
      line === authored ? [index] : []
    );
    if (liveBodyIndices.length > 0 && localBodyIndices.length > 0) {
      const liveBodyBoundary = section === "head"
        ? liveBodyIndices[0]
        : liveBodyIndices.at(-1);
      const localBodyBoundary = section === "head"
        ? localBodyIndices[0]
        : localBodyIndices.at(-1);
      const liveIsSection = section === "head"
        ? liveIndices.some((index) => index < liveBodyBoundary)
        : liveIndices.some((index) => index > liveBodyBoundary);
      const localIsSection = section === "head"
        ? localIndices.some((index) => index < localBodyBoundary)
        : localIndices.some((index) => index > localBodyBoundary);
      if (liveIsSection && !localIsSection) {
        return { section, authored };
      }
      continue;
    }
    if (localLines.length === 0) {
      return { section, authored };
    }
  }
  return null;
}

function localOutputIsLiveOutputWithoutGeneratedWrapper(
  liveNodes,
  liveTopLevelWrappers,
  localNodes,
) {
  if (liveTopLevelWrappers.length !== 1) return false;
  const wrapper = liveTopLevelWrappers[0];
  const wrapperIndex = liveNodes.indexOf(wrapper);
  if (wrapperIndex < 0) return false;
  const unwrappedLiveNodes = [
    ...liveNodes.slice(0, wrapperIndex),
    ...(wrapper.children ?? []),
    ...liveNodes.slice(wrapperIndex + 1),
  ];
  return JSON.stringify(unwrappedLiveNodes) === JSON.stringify(localNodes ?? []);
}

const EVIDENCED_MALFORMED_DEFAULT_ROW_HEAD =
  "[[module Listpages @@以降という認識で良い。 [[/footnote]]";

function defaultListPagesRowShell(item) {
  if (
    item?.type !== "element" ||
    item.name !== "div" ||
    !nodeHasClass(item, "list-pages-item") ||
    (item.children ?? []).length < 2
  ) {
    return null;
  }
  const [heading, attribution] = item.children;
  const span = heading?.children?.length === 1
    ? heading.children[0]
    : null;
  const link = span?.children?.length === 1
    ? span.children[0]
    : null;
  const printusers = descendantElements(
    attribution,
    (node) => nodeHasClass(node, "printuser"),
  );
  const dates = descendantElements(
    attribution,
    (node) => nodeHasClass(node, "odate"),
  );
  if (
    heading?.type !== "element" ||
    heading.name !== "h1" ||
    span?.type !== "element" ||
    span.name !== "span" ||
    link?.type !== "element" ||
    link.name !== "a" ||
    !/^\/(?!\/)[^\s]*$/u.test(nodeAttribute(link, "href") ?? "") ||
    nodeText(link).trim().length === 0 ||
    attribution?.type !== "element" ||
    attribution.name !== "p" ||
    !nodeText(attribution).startsWith("by ") ||
    printusers.length !== 1 ||
    dates.length !== 1
  ) {
    return null;
  }
  return {
    type: item.type,
    name: item.name,
    namespace: item.namespace,
    attrs: item.attrs,
    children: [heading, attribution],
  };
}

function malformedDefaultRowsHaveExactListPagesShell({
  invocation,
  liveTopLevelWrappers,
  localTopLevelWrappers,
  localUnsupportedDiagnostic,
}) {
  if (
    localUnsupportedDiagnostic ||
    invocation === null ||
    invocation.head !== EVIDENCED_MALFORMED_DEFAULT_ROW_HEAD ||
    invocation.balanced !== false ||
    invocation.malformed_reason !== "missing-module-close" ||
    invocation.attributes.length !== 0 ||
    liveTopLevelWrappers.length !== 1 ||
    localTopLevelWrappers.length !== 1
  ) {
    return false;
  }
  const project = (wrapper) => {
    if (
      wrapper?.type !== "element" ||
      wrapper.name !== "div" ||
      !nodeHasClass(wrapper, "list-pages-box")
    ) {
      return null;
    }
    const children = wrapper.children ?? [];
    const pagers = children
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => nodeHasClass(node, "pager"));
    if (
      pagers.length !== 1 ||
      pagers[0].index !== children.length - 1 ||
      children.length < 2
    ) {
      return null;
    }
    const rows = children.slice(0, -1).map(defaultListPagesRowShell);
    if (rows.length === 0 || rows.some((row) => row === null)) {
      return null;
    }
    return {
      type: wrapper.type,
      name: wrapper.name,
      namespace: wrapper.namespace,
      attrs: wrapper.attrs,
      rows,
      pager: pagers[0].node,
    };
  };
  const live = project(liveTopLevelWrappers[0]);
  const local = project(localTopLevelWrappers[0]);
  return live !== null &&
    local !== null &&
    JSON.stringify(live) === JSON.stringify(local);
}

function randomSelectedRowTemplateKind(invocation) {
  if (
    invocation === null ||
    lastArgumentValue(invocation, "order")?.trim().toLowerCase() !== "random"
  ) {
    return null;
  }
  const limit = lastArgumentValue(invocation, "limit")?.trim() ?? "";
  const perPage = lastArgumentValue(invocation, "perpage")?.trim() ?? "";
  if (
    ![limit, perPage].some((value) => /^(?:@url\|)?[1-9][0-9]*$/iu.test(value))
  ) {
    return null;
  }
  const body = invocation.body;
  if (/%%(?:title_linked|linked_title)%%/iu.test(body)) {
    return "linked-title";
  }
  if (/%%name%%/iu.test(body) && /%%title%%/iu.test(body)) {
    return "name-title";
  }
  if (
    /%%size%%\s*%\s*[0-9]+/iu.test(body) &&
    /#ifexpr/iu.test(body)
  ) {
    return "size-branch";
  }
  return null;
}

function cloneRandomStateNode(node, normalizeContent) {
  if (node?.type === "text") {
    return normalizeContent
      ? { ...node, value: "__RANDOM_SELECTED_ROW_TEXT__" }
      : { ...node };
  }
  if (node?.type !== "element") return { ...node };
  return {
    ...node,
    attrs: (node.attrs ?? []).map((attribute) => ({
      ...attribute,
      value: normalizeContent
        ? "__RANDOM_SELECTED_ROW_ATTRIBUTE__"
        : attribute.value,
    })),
    children: (node.children ?? []).map((child) =>
      cloneRandomStateNode(child, normalizeContent)
    ),
  };
}

function normalizeRandomSelectedRowState(nodes, wrapperExpected) {
  if (!wrapperExpected) {
    return (nodes ?? []).map((node) => cloneRandomStateNode(node, true));
  }
  const normalizeWrapper = (wrapper) => {
    const hasItems = descendantElements(
      wrapper,
      (node) => nodeHasClass(node, "list-pages-item"),
    ).length > 0;
    const normalizeChild = (child) => {
      if (nodeHasClass(child, "pager")) {
        return cloneRandomStateNode(child, false);
      }
      if (!wrapperExpected || !hasItems) {
        return cloneRandomStateNode(child, true);
      }
      if (nodeHasClass(child, "list-pages-item")) {
        return cloneRandomStateNode(child, true);
      }
      return cloneRandomStateNode(child, false);
    };
    return {
      ...wrapper,
      attrs: (wrapper.attrs ?? []).map((attribute) => ({ ...attribute })),
      children: (wrapper.children ?? []).map(normalizeChild),
    };
  };
  return (nodes ?? []).map((node) =>
    nodeHasClass(node, "list-pages-box")
      ? normalizeWrapper(node)
      : cloneRandomStateNode(node, false)
  );
}

function relativeTimeSelector(invocation) {
  if (invocation === null) return null;
  for (const attribute of invocation.attributes) {
    if (!/(?:^date$|^created_at$|^updated_at$)/iu.test(attribute.name)) {
      continue;
    }
    const value = attribute.value.trim();
    if (/^(?:last|older than)\s+[0-9]+\s+(?:day|days|hour|hours)$/iu.test(value) ||
      /^(?:@url\|)?last\s+month$/iu.test(value)) {
      return { name: attribute.name.toLowerCase(), value };
    }
  }
  return null;
}

function normalizeRelativeTemporalNode(node) {
  if (node?.type !== "element") return { ...node };
  if (nodeHasClass(node, "odate")) {
    return {
      type: node.type,
      name: node.name,
      namespace: node.namespace,
      attrs: (node.attrs ?? []).map((attribute) => ({
        ...attribute,
        value: attribute.name === "class"
          ? attribute.value.replace(/\btime_[0-9]+\b/gu, "time__RELATIVE__")
          : attribute.value,
      })),
      children: [{ type: "text", value: "__RELATIVE_DATE__" }],
    };
  }
  return {
    ...node,
    attrs: (node.attrs ?? []).map((attribute) => ({ ...attribute })),
    children: (node.children ?? []).map(normalizeRelativeTemporalNode),
  };
}

function relativeTemporalBodyUsesOnlyDynamicFields(body) {
  const withoutDynamicFields = body
    .replace(
      /%%(?:created_at|updated_at|created_by|fullname|title|title_linked|linked_title|rating|votes|children|name|link)(?:\|[^%]*)?%%/giu,
      "",
    )
    .replace(/%%content\{[0-9]+\}%%/giu, "")
    .replace(/[\s>*|()[\]{}"=:/%?&;,_+\-]/gu, "");
  return !/[\p{L}\p{N}]/u.test(withoutDynamicFields);
}

function normalizeRelativeTemporalTableNode(node, inRow = false, inPager = false) {
  if (node?.type === "text") {
    return inRow || inPager
      ? { ...node, value: "__RELATIVE_DYNAMIC_TEXT__" }
      : { ...node };
  }
  if (node?.type !== "element") return { ...node };
  const row = inRow || node.name === "tr";
  const pager = inPager || nodeHasClass(node, "pager");
  return {
    ...node,
    attrs: (node.attrs ?? []).map((attribute) => ({
      ...attribute,
      value: row && attribute.name === "href" &&
          /^\/(?!ajax-module-connector\.php\/)/iu.test(attribute.value)
        ? "__RELATIVE_DYNAMIC_HREF__"
        : pager && attribute.name === "href"
          ? "__RELATIVE_PAGER_HREF__"
          : nodeHasClass(node, "odate") && attribute.name === "class"
            ? attribute.value.replace(/\btime_[0-9]+\b/gu, "time__RELATIVE__")
            : attribute.value,
    })),
    children: (node.children ?? []).map((child) =>
      normalizeRelativeTemporalTableNode(child, row, pager)
    ),
  };
}

function relativeTemporalTableFixtureProof({
  invocation,
  liveWrapper,
  localWrapper,
  bound,
}) {
  if (!relativeTemporalBodyUsesOnlyDynamicFields(invocation.body)) {
    return null;
  }
  const table = (wrapper) => {
    const matches = descendantElements(
      wrapper,
      (node) => node.name === "table" && nodeHasClass(node, "wiki-content-table"),
    );
    return matches.length === 1 ? matches[0] : null;
  };
  const liveTable = table(liveWrapper);
  const localTable = table(localWrapper);
  if (liveTable === null || localTable === null) return null;
  const rows = (tableNode) => descendantElements(
    tableNode,
    (node) => node.name === "tr",
  );
  const liveRows = rows(liveTable);
  const localRows = rows(localTable);
  if (
    liveRows.length === 0 ||
    localRows.length === 0 ||
    liveRows.length > bound ||
    localRows.length > bound ||
    liveRows.some((row) => descendantElements(row, (node) =>
      node.name === "a" && /^\/(?!ajax-module-connector\.php\/)/iu.test(
        nodeAttribute(node, "href") ?? "",
      )
    ).length === 0) ||
    localRows.some((row) => descendantElements(row, (node) =>
      node.name === "a" && /^\/(?!ajax-module-connector\.php\/)/iu.test(
        nodeAttribute(node, "href") ?? "",
      )
    ).length === 0)
  ) {
    return null;
  }
  const liveNormalized = normalizeRelativeTemporalTableNode(liveWrapper);
  const localNormalized = normalizeRelativeTemporalTableNode(localWrapper);
  return JSON.stringify(liveNormalized) === JSON.stringify(localNormalized)
    ? { mode: "table-row-set" }
    : null;
}

function relativeTemporalFixtureProof({
  invocation,
  liveNodes,
  localNodes,
  liveTopLevelWrappers,
  localTopLevelWrappers,
}) {
  const selector = relativeTimeSelector(invocation);
  if (
    selector === null ||
    liveTopLevelWrappers.length !== 1 ||
    localTopLevelWrappers.length !== 1
  ) {
    return null;
  }
  const liveWrapper = liveTopLevelWrappers[0];
  const localWrapper = localTopLevelWrappers[0];
  const liveItems = descendantElements(
    liveWrapper,
    (node) => nodeHasClass(node, "list-pages-item"),
  );
  const localItems = descendantElements(
    localWrapper,
    (node) => nodeHasClass(node, "list-pages-item"),
  );
  const limit = lastArgumentValue(invocation, "limit")?.trim() ?? "";
  const perPage = lastArgumentValue(invocation, "perpage")?.trim() ?? "";
  const bounds = [limit, perPage]
    .map((value) => /^(?:@url\|)?(?<count>[1-9][0-9]*)$/iu.exec(value)?.groups?.count)
    .filter(Boolean)
    .map(Number);
  const bound = bounds.length === 0 ? 0 : Math.min(...bounds);
  if (bound === 0 || liveItems.length > bound || localItems.length > bound) return null;
  if (liveItems.length === 0 && localItems.length === 0) {
    const tableProof = relativeTemporalTableFixtureProof({
      invocation,
      liveWrapper,
      localWrapper,
      bound,
    });
    return tableProof === null ? null : { selector, ...tableProof };
  }
  if (localItems.length === 0) {
    const localChildren = (localWrapper.children ?? []).filter((node) =>
      !(node.type === "text" && node.value.trim() === "")
    );
    if (localChildren.length !== 0) return null;
    const liveRowsHaveTemporalMetadata = liveItems.every((item) =>
      descendantElements(item, (node) => nodeHasClass(node, "odate")).length > 0
    );
    const randomRelativeSelectedLinkRows =
      lastArgumentValue(invocation, "order")?.trim().toLowerCase() === "random" &&
      invocationExpectsWrapper(invocation) === true &&
      !/#ifexpr\b/iu.test(invocation.body) &&
      /%%(?:link|title_linked|linked_title)%%/iu.test(invocation.body) &&
      liveItems.every((item) =>
        descendantElements(item, (node) => node.name === "a").length === 1
      );
    if (!liveRowsHaveTemporalMetadata && !randomRelativeSelectedLinkRows) {
      return null;
    }
    return { selector, mode: "live-row-local-empty" };
  }
  if (liveItems.length !== 1 || localItems.length !== 1) return null;
  const liveNormalized = liveNodes.map(normalizeRelativeTemporalNode);
  const localNormalized = localNodes.map(normalizeRelativeTemporalNode);
  return JSON.stringify(liveNormalized) === JSON.stringify(localNormalized)
    ? { selector, mode: "same-row-date-only" }
    : null;
}

function normalizeUrlSelectorFixtureNode(node, inRows = false) {
  if (node?.type === "text") {
    return inRows
      ? { ...node, value: "__URL_SELECTOR_ROW_TEXT__" }
      : { ...node };
  }
  if (node?.type !== "element") return { ...node };
  const row = inRows || node.name === "blockquote";
  const selectedLink =
    row &&
    node.name === "a" &&
    nodeAttribute(node, "target") === "_blank" &&
    /^\/(?!\/)/u.test(nodeAttribute(node, "href") ?? "");
  const importedUserLink = row &&
    node.name === "a" &&
    /(?:^|\/)user:info\//iu.test(nodeAttribute(node, "href") ?? "");
  return {
    ...node,
    attrs: (node.attrs ?? []).map((attribute) => ({
      ...attribute,
      value: selectedLink && attribute.name === "href"
        ? "__URL_SELECTOR_SELECTED_LINK_HREF__"
        : row && nodeHasClass(node, "odate") && attribute.name === "class"
          ? attribute.value.replace(/\btime_[0-9]+\b/gu, "time__URL_SELECTOR_DATE__")
          : importedUserLink &&
              ["href", "onclick"].includes(attribute.name)
            ? `__URL_SELECTOR_USER_${attribute.name.toUpperCase()}__`
            : row && node.name === "img" &&
                ["alt", "src", "style"].includes(attribute.name)
              ? `__URL_SELECTOR_AVATAR_${attribute.name.toUpperCase()}__`
              : attribute.value,
    })),
    children: (node.children ?? []).map((child) =>
      normalizeUrlSelectorFixtureNode(child, row || selectedLink)
    ),
  };
}

function urlSelectorBodyUsesOnlyDynamicFields(body) {
  const withoutDynamicFields = body
    .replace(
      /%%(?:created_at|created_by|fullname|title)(?:\|.*?)?%%/giu,
      "",
    )
    .replace(/\[\[[\s\S]*?\]\]/gu, "")
    .replace(/@@/gu, "")
    .replace(/[\s>*|()[\]{}"=:/%?&;,_+\-]/gu, "");
  return !/[\p{L}\p{N}]/u.test(withoutDynamicFields);
}

function urlSelectorFixtureProof({
  invocation,
  liveNodes,
  localNodes,
  liveTopLevelWrappers,
  localTopLevelWrappers,
}) {
  if (
    invocation === null ||
    lastArgumentValue(invocation, "created_at")?.trim() !== "@URL" ||
    lastArgumentValue(invocation, "perpage")?.trim() !== "250" ||
    lastArgumentValue(invocation, "separate")?.trim().toLowerCase() !== "no" ||
    lastArgumentValue(invocation, "order")?.trim().toLowerCase() !== "created_by" ||
    !/%%created_by(?:_linked)?%%/iu.test(invocation.body) ||
    !/%%fullname%%/iu.test(invocation.body) ||
    !/%%title%%/iu.test(invocation.body) ||
    !urlSelectorBodyUsesOnlyDynamicFields(invocation.body) ||
    liveTopLevelWrappers.length !== 1 ||
    localTopLevelWrappers.length !== 1
  ) {
    return null;
  }
  const project = (wrapper) => {
    const children = wrapper.children ?? [];
    const pager = children.filter((node) => nodeHasClass(node, "pager"));
    const rows = children.filter((node) => node.type === "element" &&
      node.name === "blockquote");
    if (pager.length !== 1 || rows.length !== 1 || children.length !== 2) {
      return null;
    }
    const selectedLinks = descendantElements(
      rows[0],
      (node) =>
        node.name === "a" &&
        nodeAttribute(node, "target") === "_blank" &&
        /^\/(?!\/)/u.test(nodeAttribute(node, "href") ?? ""),
    );
    if (selectedLinks.length === 0) return null;
    return normalizeUrlSelectorFixtureNode(wrapper);
  };
  const live = project(liveTopLevelWrappers[0]);
  const local = project(localTopLevelWrappers[0]);
  return live !== null && local !== null &&
    JSON.stringify(live) === JSON.stringify(local)
    ? { perPage: 250 }
    : null;
}

function importedPageIncludeTargets(source) {
  return [...source.matchAll(
    /\[\[(?:%%content\{[0-9]+\}%%)?include\s+:(?:[^\s:\]]+:)?(?<page>[^|\]\s\r\n]+)(?=\s*(?:\r?\n|\||\]\]))/giu,
  )].map((match) => match.groups.page);
}

function synchronizedImportedIncludeFixtureProof({
  source,
  invocation,
  liveNodes,
  localNodes,
  localUnsupportedDiagnostic,
}) {
  if (localUnsupportedDiagnostic) return null;
  const includeTargets = importedPageIncludeTargets(source);
  if (includeTargets.length === 0) {
    return null;
  }
  const distinctIncludeTargets = [...new Set(includeTargets)];
  const localErrors = descendantElements(
    { type: "element", name: "root", children: localNodes },
    (node) => nodeHasClass(node, "error-block"),
  );
  const errorTargets = localErrors.flatMap((node) => {
    const match = /^Included page "(?<page>[^"]+)" does not exist \(/u.exec(
      nodeText(node).trim(),
    );
    return match === null ? [] : [match.groups.page];
  });
  const directRepeatedConditional =
    invocation !== null &&
    lastArgumentValue(invocation, "order")?.trim().toLowerCase() === "random" &&
    /^(?:@url\|)?1$/iu.test(
      lastArgumentValue(invocation, "limit")?.trim() ?? "",
    ) &&
    invocationExpectsWrapper(invocation) === false &&
    invocationUsesCombinedSections(invocation) &&
    distinctIncludeTargets.length === 1 &&
    includeTargets.length >= 2 &&
    /\[\[#ifexpr\b/iu.test(source) &&
    /\[\[(?:%%content\{[0-9]+\}%%)?include\s+:[^\s:\]]+:[^\s\]|]+/iu.test(source) &&
    errorTargets.length === 1 &&
    errorTargets[0] === distinctIncludeTargets[0] &&
    liveNodes.length === 1 &&
    liveNodes[0]?.type === "element" &&
    localNodes.length === 1 &&
    localNodes[0]?.type === "element" &&
    nodeHasClass(localNodes[0], "error-block") &&
    !["list-pages-box", "list-pages-item", "pager"].some((className) =>
      domHasClass(liveNodes, className) || domHasClass(localNodes, className)
    );
  if (directRepeatedConditional) {
    return {
      includeTargets: distinctIncludeTargets,
      mode: "repeated-conditional-direct",
    };
  }
  if (
    errorTargets.length !== distinctIncludeTargets.length ||
    JSON.stringify([...errorTargets].sort()) !==
      JSON.stringify([...distinctIncludeTargets].sort())
  ) {
    return null;
  }
  const liveOwned = outermostListPagesOwnedSubtrees(liveNodes);
  const localOwned = outermostListPagesOwnedSubtrees(localNodes);
  if (
    liveOwned.length !== localOwned.length + 1 ||
    localOwned.length === 0 ||
    JSON.stringify(liveOwned.slice(0, localOwned.length)) !==
      JSON.stringify(localOwned)
  ) {
    return null;
  }
  const importedWrapper = liveOwned.at(-1);
  if (
    importedWrapper?.type !== "element" ||
    (importedWrapper.children ?? []).some((child) => child.type === "element") ||
    descendantElements(
      importedWrapper,
      (node) => nodeHasClass(node, "list-pages-item") || nodeHasClass(node, "pager"),
    ).length > 0
  ) {
    return null;
  }
  return {
    includeTargets,
    mode: "wrapper",
    importedWrapper,
  };
}

function classifyMismatch(row, reference) {
  const source = reference.syntax_case.source;
  const liveText = row.live.visible_text;
  const localText = row.local?.visible_text ?? "";
  const liveHtml = reference.raw_html;
  const liveNodes = canonicalDom(liveHtml);
  const localNodes = localDom(row);
  const invocation = exactSingleInvocation(source);
  const invocations = extractListPagesInvocationsFromSource({
    branch: "classification",
    pageFullname: "preview",
    sourcePath: "preview",
    source,
  });
  const liveTopLevelWrappers = topLevelNodesWithClass(
    liveNodes,
    "list-pages-box",
  );
  const localTopLevelWrappers = topLevelNodesWithClass(
    localNodes,
    "list-pages-box",
  );
  const liveHasListPages =
    domHasClass(liveNodes, "list-pages-box") ||
    domHasClass(liveNodes, "list-pages-item") ||
    domHasClass(liveNodes, "pager") ||
    resolvesTemplateVariables(source, liveText);
  const localHasListPages =
    domHasClass(localNodes, "list-pages-box") ||
    domHasClass(localNodes, "list-pages-item") ||
    domHasClass(localNodes, "pager") ||
    resolvesTemplateVariables(source, localText);
  const localPreservedModule =
    localText.includes("[[module ListPages") ||
    localText.includes("[[module\tListPages");
  const localUnsupportedDiagnostic =
    /\bTODO:\s*module\s+ListPages\b/iu.test(localText);
  const missingLineArgument =
    missingVisibleLineArgument(source, liveText, localText);
  const missingAuthoredSection = invocation !== null &&
      liveTopLevelWrappers.length === 1 &&
      localTopLevelWrappers.length === 1
    ? missingPlainAuthoredSection({
        invocation,
        liveWrapper: liveTopLevelWrappers[0],
        localWrapper: localTopLevelWrappers[0],
      })
    : null;

  if (hasExactPagePreviewTransportWhitespace({
    row,
    reference,
    liveNodes,
    localNodes,
  })) {
    return {
      classification: "page-preview-transport-whitespace",
      disposition: "none",
      rationale:
        "The complete internal canonical DOM and visible text match; only the exact observed PagePreview response envelope adds outer indentation whitespace.",
    };
  }
  if (hasBareDefaultListPagesFixtureState({ source, liveNodes, localNodes })) {
    return {
      classification: "inconclusive-fixture-data-state",
      disposition: "replay-synchronized-fixture",
      rationale:
        "The exact bare own-line invocation executes in both runtimes with the default newest-first row shell, a twenty-row live page and pager, and flat sibling rows; the disjoint selected page identities prove that the captured live and imported local fixtures cannot be reconciled row for row.",
    };
  }

  if (literalContextKeepsListPagesInactive({
    row,
    reference,
    localNodes,
    localUnsupportedDiagnostic,
  })) {
    return {
      classification: "literal-context-nonexecution-parity",
      disposition: "none",
      rationale:
        "The context-preserving replay keeps ListPages inactive in both runtimes; unrelated code, HTML, typography, or whitespace differences remain outside the ListPages campaign.",
    };
  }
  if (literalContextHasExactListPagesExecution({
    row,
    liveNodes,
    localNodes,
    localUnsupportedDiagnostic,
  })) {
    return {
      classification: "literal-context-listpages-execution-parity",
      disposition: "none",
      rationale:
        "The complete canonical ListPages-owned subtree matches exactly in this context-preserving replay; the remaining DOM drift is outside ListPages ownership.",
    };
  }
  if (literalDocumentationKeepsListPagesInactive({
    source,
    liveText,
    localText,
    liveNodes,
    localNodes,
    localUnsupportedDiagnostic,
  })) {
    return {
      classification: "literal-documentation-nonexecution-parity",
      disposition: "none",
      rationale:
        "The source begins with an evidenced argumentless documentation opener, every complete ListPages opening remains visibly literal in both runtimes, neither runtime emits ListPages-owned DOM, and Wikijump emits no unsupported diagnostic; remaining preview drift is outside ListPages execution.",
    };
  }
  if (hasExactListPagesOwnedExecution({
    invocations,
    liveNodes,
    localNodes,
    localUnsupportedDiagnostic,
  })) {
    return {
      classification: "listpages-owned-execution-parity",
      disposition: "none",
      rationale:
        "The complete canonical ListPages-owned subtree matches exactly; all remaining DOM drift is outside ListPages ownership.",
    };
  }
  if (malformedDefaultRowsHaveExactListPagesShell({
    invocation,
    liveTopLevelWrappers,
    localTopLevelWrappers,
    localUnsupportedDiagnostic,
  })) {
    return {
      classification: "listpages-malformed-default-row-shell-parity",
      disposition: "none",
      rationale:
        "For the exact evidenced unterminated @@…[[/footnote]] opener, both runtimes emit one default ListPages wrapper with the identical ordered row-link/title and author/date shell for every selected page plus an identical pager. Remaining drift is confined to selected pages' nested non-ListPages rendering and the enclosing page's FTML output; this records ListPages ownership parity, not a complete preview match.",
      };
  }
  const relativeTemporalFixture = relativeTemporalFixtureProof({
    invocation,
    liveNodes,
    localNodes,
    liveTopLevelWrappers,
    localTopLevelWrappers,
  });
  if (
    relativeTemporalFixture !== null &&
    /%%(?:created_at|updated_at|created_by|name|title|title_linked|linked_title|link|fullname|rating|votes|children|content\{[0-9]+\})(?:\|[^\r\n]*)?%%/iu
      .test(invocation.body) &&
    !localUnsupportedDiagnostic
  ) {
    return {
      classification: "synchronized-relative-time-query-state",
      disposition: "none",
      rationale:
        `The ListPages ${relativeTemporalFixture.selector.name} selector uses the evidenced relative-time form (${relativeTemporalFixture.selector.value}); the captured live time window and local fixture clock differ, yielding ${relativeTemporalFixture.mode}.`,
      };
  }
  const urlSelectorFixture = urlSelectorFixtureProof({
    invocation,
    liveNodes,
    localNodes,
    liveTopLevelWrappers,
    localTopLevelWrappers,
  });
  if (urlSelectorFixture !== null && !localUnsupportedDiagnostic) {
    return {
      classification: "synchronized-url-selector-fixture-state",
      disposition: "none",
      rationale:
        `The exact created_at="@URL" ListPages selector uses perPage=${urlSelectorFixture.perPage}; both runtimes emit the same one-wrapper blockquote/pager shell and row element structure while the captured URL-selected page set differs between live and imported fixtures.`,
      };
  }
  const importedIncludeFixture = synchronizedImportedIncludeFixtureProof({
    source,
    invocation,
    liveNodes,
    localNodes,
    localUnsupportedDiagnostic,
  });
  if (importedIncludeFixture !== null) {
    return {
      classification: "synchronized-imported-include-state",
      disposition: "none",
      rationale: importedIncludeFixture.mode === "repeated-conditional-direct"
        ? `The random wrapper-free ListPages body repeats one namespaced imported include across conditional branches; Wikidot emits one direct imported subtree while the local fixture emits the exact missing-page error for that target, with no ListPages-owned DOM on either side.`
        : `The source includes ${importedIncludeFixture.includeTargets.length} distinct pages whose imported fixture is absent locally; local Wikijump emits the exact missing-page errors, while the common ListPages wrappers match and the live-only imported wrapper is empty of rows and pagination.`,
    };
  }
  const randomOrder = invocation === null
    ? null
    : lastArgumentValue(invocation, "order")?.trim().toLowerCase();
  const randomLimit = invocation === null
    ? null
    : lastArgumentValue(invocation, "limit")?.trim();
  const randomRedirectBody = invocation !== null &&
    /^\s*\[\[include\s+:snippets:redirect\s+url=%%link%%\]\]\s*$/iu
      .test(invocation.body);
  const liveRedirectIframes = liveTopLevelWrappers.length === 1
    ? descendantElements(
      liveTopLevelWrappers[0],
      (node) => node.name === "iframe" &&
        /^https:\/\/snippets\.(?:wdfiles\.com|files\.invalid)\/local--code\/code:iframe-redirect#http:\/\/sandbox-for-codex\.wikidot\.com\/[^\s]+$/u
          .test(nodeAttribute(node, "src") ?? ""),
    )
    : [];
  const localRedirectErrors = localTopLevelWrappers.length === 1
    ? descendantElements(
      localTopLevelWrappers[0],
      (node) => nodeHasClass(node, "error-block") &&
        nodeText(node).trim() === "Sorry, no match for the embedded content.",
    )
    : [];
  if (
    invocation !== null &&
    relativeTimeSelector(invocation) === null &&
    randomOrder === "random" &&
    /(?:^|\|)1$/u.test(randomLimit ?? "") &&
    randomRedirectBody &&
    liveText === "" &&
    localText === "Sorry, no match for the embedded content." &&
    liveTopLevelWrappers.length === 1 &&
    localTopLevelWrappers.length === 1 &&
    descendantElements(
      liveTopLevelWrappers[0],
      (node) => nodeHasClass(node, "list-pages-item"),
    ).length === 1 &&
    descendantElements(
      localTopLevelWrappers[0],
      (node) => nodeHasClass(node, "list-pages-item"),
    ).length === 1 &&
    liveRedirectIframes.length === 1 &&
    localRedirectErrors.length === 1 &&
      !localUnsupportedDiagnostic
  ) {
    return {
      classification: "unsynchronized-random-row-state",
      disposition: "none",
      rationale:
        "The exact one-row random redirect invocation selects different cached fixture pages: Wikidot emits its canonical snippets redirect iframe for one selected link while the local fixture's selected link resolves to the canonical no-match error. This is a selected-row data-state difference, not a deterministic ListPages query or renderer contract.",
    };
  }
  if (
    invocation !== null &&
    relativeTimeSelector(invocation) === null &&
    randomOrder === "random" &&
    /(?:^|\|)1$/u.test(randomLimit ?? "") &&
    /%%(?:size|link)%%/iu.test(invocation.body) &&
    liveText === localText &&
    liveHasListPages &&
    localHasListPages &&
    !localUnsupportedDiagnostic
  ) {
    return {
      classification: "unsynchronized-random-row-state",
      disposition: "none",
      rationale:
        "The exact one-row invocation orders randomly and exposes selected-page size or link state in its body. Both runtimes execute with identical visible output, but their independently cached random fixture selections cannot have comparable metadata DOM.",
      };
  }
  const randomTemplateKind = randomSelectedRowTemplateKind(invocation);
  const randomExpectedWrapper = invocation === null
    ? null
    : invocationExpectsWrapper(invocation);
  const randomLiveStructure = randomExpectedWrapper === null
    ? null
    : normalizeRandomSelectedRowState(liveNodes, randomExpectedWrapper);
  const randomLocalStructure = randomExpectedWrapper === null
    ? null
    : normalizeRandomSelectedRowState(localNodes, randomExpectedWrapper);
  if (
    randomTemplateKind !== null &&
    relativeTimeSelector(invocation) === null &&
    randomExpectedWrapper !== null &&
    liveHasListPages &&
    localHasListPages &&
    !localUnsupportedDiagnostic &&
    liveTopLevelWrappers.length === localTopLevelWrappers.length &&
    liveTopLevelWrappers.length > 0 &&
    JSON.stringify(randomLiveStructure) ===
      JSON.stringify(randomLocalStructure) &&
    JSON.stringify(liveNodes) !== JSON.stringify(localNodes)
  ) {
    return {
      classification: "unsynchronized-random-row-state",
      disposition: "none",
      rationale:
      `The random ListPages body is the evidenced ${randomTemplateKind} selected-row form; both runtimes have the same wrapper/row structure after replacing only row-substitution text and attributes, while their independently cached selected fixture rows differ.`,
    };
  }
  const randomDirectStructureMatches =
    randomTemplateKind !== null &&
    relativeTimeSelector(invocation) === null &&
    randomExpectedWrapper === false &&
    liveTopLevelWrappers.length === 0 &&
    localTopLevelWrappers.length === 0 &&
    !["list-pages-box", "list-pages-item", "pager"].some((className) =>
      domHasClass(liveNodes, className) || domHasClass(localNodes, className)
    ) &&
    liveNodes.length === 1 &&
    (localNodes.length === 0 || localNodes.length === 1) &&
    JSON.stringify(randomLiveStructure) ===
      JSON.stringify(randomLocalStructure) &&
    JSON.stringify(liveNodes) !== JSON.stringify(localNodes);
  if (randomDirectStructureMatches) {
    return {
      classification: "unsynchronized-random-row-state",
      disposition: "none",
      rationale:
        `The random wrapper-free ListPages body is the evidenced ${randomTemplateKind} selected-row form; both runtimes emit the same direct element structure after replacing only selected-row text and attributes, while the cached random row differs.`,
    };
  }
  const randomCssBranchFixture =
    invocation !== null &&
    relativeTimeSelector(invocation) === null &&
    randomTemplateKind === "size-branch" &&
    randomExpectedWrapper === false &&
    liveTopLevelWrappers.length === 0 &&
    localTopLevelWrappers.length === 0 &&
    liveNodes.length === 1 &&
    liveNodes[0]?.type === "element" &&
    nodeHasClass(liveNodes[0], "code") &&
    descendantElements(liveNodes[0], (node) => node.name === "pre").length === 1 &&
    nodeText(liveNodes[0]).trim().length > 0 &&
    (
      localNodes.length === 0 ||
      (
        localNodes.length === 1 &&
        localNodes[0]?.type === "element" &&
        nodeHasClass(localNodes[0], "code") &&
        descendantElements(localNodes[0], (node) => node.name === "pre").length === 1 &&
        nodeText(localNodes[0]).trim().length > 0
      )
    ) &&
    JSON.stringify(liveNodes) !== JSON.stringify(localNodes);
  if (randomCssBranchFixture) {
    return {
      classification: "unsynchronized-random-row-state",
      disposition: "none",
      rationale:
        "The wrapper-free random ListPages body is the evidenced generated CSS size-branch form. Wikidot selected a non-empty CSS code row while the local fixture selected either another code row or no row; the independently selected imported row changes only fixture data, not the ListPages query or renderer contract.",
    };
  }
  const importedAuthorNames = new Set([
    ...synchronizedImportedAuthorNames(liveNodes),
    ...synchronizedImportedAuthorNames(localNodes),
  ]);
  const liveAuthorFixture = normalizeSynchronizedRuntimeFixtures(
    liveNodes,
    { importedAuthorNames },
  );
  const localAuthorFixture = normalizeSynchronizedRuntimeFixtures(
    localNodes,
    { importedAuthorNames },
  );
  const liveAuthorPageExistence = normalizeSynchronizedImportedPageExistence(
    liveAuthorFixture.nodes,
  );
  const localAuthorPageExistence = normalizeSynchronizedImportedPageExistence(
    localAuthorFixture.nodes,
  );
  if (
    (liveAuthorFixture.state.importedAuthors > 0 ||
      localAuthorFixture.state.importedAuthors > 0) &&
    JSON.stringify(liveAuthorPageExistence.nodes) ===
      JSON.stringify(localAuthorPageExistence.nodes)
  ) {
    return {
      classification: "synchronized-imported-author-state",
      disposition: "none",
      rationale:
        "Visible row output and all non-provenance DOM match after normalizing only live printuser identities, their exact plain imported-name fallback, ODate metadata, and identical imported internal-link existence markers.",
    };
  }
  const liveLinkedTitle = normalizeSynchronizedLinkedTitleSpaces(
    liveAuthorFixture.nodes,
  );
  const localLinkedTitle = normalizeSynchronizedLinkedTitleSpaces(
    localAuthorFixture.nodes,
  );
  const sourceUsesLinkedTitle =
    /%%(?:title_linked|linked_title)%%/iu.test(source) ||
    /\[\*[ \t]*%%link%%[ \t]+%%title%%[ \t]*\]/iu.test(source);
  const sourceUsesComposedLinkedTitle =
    /\[\[\[[ \t]*%%link%%\/noredirect\/true[ \t]*\|[ \t]*%%title%%[ \t]*\]\]\]/iu
      .test(source);
  const linkedTitleTypography = sourceUsesLinkedTitle
    ? normalizeSynchronizedLinkedTitleTypography(
        liveLinkedTitle.nodes,
        localLinkedTitle.nodes,
      )
    : {
        live: liveLinkedTitle.nodes,
        local: localLinkedTitle.nodes,
        normalizedTitles: 0,
      };
  const liveComposedLinkedTitle = sourceUsesComposedLinkedTitle
    ? normalizeSynchronizedComposedLinkedTitles(linkedTitleTypography.live)
    : { nodes: linkedTitleTypography.live, normalizedTitles: 0 };
  const localComposedLinkedTitle = sourceUsesComposedLinkedTitle
    ? normalizeSynchronizedComposedLinkedTitles(linkedTitleTypography.local)
    : { nodes: linkedTitleTypography.local, normalizedTitles: 0 };
  if (
    (sourceUsesLinkedTitle || sourceUsesComposedLinkedTitle) &&
    (sourceUsesComposedLinkedTitle ||
      liveText === localText ||
      linkedTitleTypography.normalizedTitles > 0) &&
    liveLinkedTitle.normalizedSpaces +
        localLinkedTitle.normalizedSpaces +
        linkedTitleTypography.normalizedTitles +
        liveComposedLinkedTitle.normalizedTitles +
        localComposedLinkedTitle.normalizedTitles >
      0 &&
    JSON.stringify(liveComposedLinkedTitle.nodes) ===
      JSON.stringify(localComposedLinkedTitle.nodes)
  ) {
    return {
      classification: "synchronized-imported-page-title-state",
      disposition: "none",
      rationale:
        "The source uses ListPages linked-title substitution or the exact authored %%link%%/noredirect/true and %%title%% composition, and the complete DOM matches after normalizing only generated link text for identical page targets plus synchronized imported-author and ODate metadata.",
    };
  }
  const liveImportedPageExistence =
    normalizeSynchronizedImportedPageExistence(liveComposedLinkedTitle.nodes);
  const localImportedPageExistence =
    normalizeSynchronizedImportedPageExistence(localComposedLinkedTitle.nodes);
  if (
    liveText === localText &&
    liveImportedPageExistence.normalizedTargets +
        localImportedPageExistence.normalizedTargets >
      0 &&
    JSON.stringify(liveImportedPageExistence.nodes) ===
      JSON.stringify(localImportedPageExistence.nodes)
  ) {
    return {
      classification: "synchronized-imported-page-existence-state",
      disposition: "none",
      rationale:
        "Visible output and the complete DOM match after removing only an exact newpage class from identical internal links whose target existence differs between the synchronized live and imported fixtures.",
    };
  }
  const liveImportedFile = normalizeSynchronizedImportedFileOrigins(
    liveImportedPageExistence.nodes,
  );
  const localImportedFile = normalizeSynchronizedImportedFileOrigins(
    localImportedPageExistence.nodes,
  );
  if (
    liveText === localText &&
    liveImportedFile.normalizedOrigins +
        localImportedFile.normalizedOrigins >
      0 &&
    JSON.stringify(liveImportedFile.nodes) ===
      JSON.stringify(localImportedFile.nodes)
  ) {
    return {
      classification: "synchronized-imported-file-origin-state",
      disposition: "none",
      rationale:
        "The complete DOM and visible output match after mapping only identical imported local-file paths between the live Wikidot site origin and the fixture's reserved files.invalid origin, plus synchronized imported metadata.",
    };
  }
  const firstImageFixture = invocation !== null &&
      /(?:^|\r?\n)[ \t]*\[\[image[ \t]+:first\]\][ \t]*(?:\r?\n|$)/iu
        .test(invocation.body) &&
      /%%(?:title_linked|linked_title)%%/iu.test(invocation.body) &&
      !["no", "false", "0"].includes(
        lastArgumentValue(invocation, "separate")?.trim().toLowerCase() ?? "yes",
      )
    ? normalizeSynchronizedFirstImageFixture(
        liveImportedFile.nodes,
        localImportedFile.nodes,
      )
    : null;
  if (
    firstImageFixture !== null &&
    liveText === localText &&
    JSON.stringify(firstImageFixture.live) ===
      JSON.stringify(firstImageFixture.local)
  ) {
    return {
      classification: "synchronized-imported-first-image-state",
      disposition: "none",
      rationale:
        "The source uses the exact executable ListPages [[image :first]] row form, every selected row is identical, and the complete DOM matches after removing only a directly owned first-image node whose local-file page owner exactly matches that row link and whose counterpart fixture has no image record.",
    };
  }
  const liveSocialNonce = normalizeSynchronizedRuntimeFixtures(
    liveNodes,
    { normalizeSocialNonce: true },
  );
  const localSocialNonce = normalizeSynchronizedRuntimeFixtures(
    localNodes,
    { normalizeSocialNonce: true },
  );
  if (
    liveSocialNonce.state.socialWidgets > 0 &&
    liveSocialNonce.state.socialWidgets ===
      localSocialNonce.state.socialWidgets &&
    liveSocialNonce.state.socialScripts ===
      liveSocialNonce.state.socialWidgets &&
    localSocialNonce.state.socialScripts ===
      localSocialNonce.state.socialWidgets &&
    liveSocialNonce.state.invalidSocialWidgets === 0 &&
    localSocialNonce.state.invalidSocialWidgets === 0 &&
    JSON.stringify(liveSocialNonce.nodes) ===
      JSON.stringify(localSocialNonce.nodes)
  ) {
    return {
      classification: "canonical-social-widget-nonce",
      disposition: "none",
      rationale:
        "The complete canonical legacy social-widget DOM and script match; only Wikidot's per-render five-digit element nonce differs.",
    };
  }
  const liveFootnoteNonce = normalizeCanonicalFootnoteNonces(
    liveImportedFile.nodes,
  );
  const localFootnoteNonce = normalizeCanonicalFootnoteNonces(
    localImportedFile.nodes,
  );
  if (
    liveText === localText &&
    liveFootnoteNonce.state.invalid === 0 &&
    localFootnoteNonce.state.invalid === 0 &&
    liveFootnoteNonce.state.references ===
      localFootnoteNonce.state.references &&
    JSON.stringify(liveFootnoteNonce.nodes) ===
      JSON.stringify(localFootnoteNonce.nodes)
  ) {
    return {
      classification: "canonical-footnote-route-nonce",
      disposition: "none",
      rationale:
        "The complete generated footnote reference/footer pairs and visible output match after synchronized imported metadata and exact imported local-file origin mapping; only Wikidot's consistent per-render numeric route nonce differs.",
    };
  }
  const tabviewSafety = /\[\[(?:tabs|tabview)(?:\s|\])/iu.test(source)
    ? compareTabviewSafetyPreservation(
      liveFootnoteNonce.state.invalid === 0
        ? liveFootnoteNonce.nodes
        : liveNodes,
      localFootnoteNonce.state.invalid === 0
        ? localFootnoteNonce.nodes
        : localNodes,
    )
    : null;
  if (
    tabviewSafety?.status === "safety-preservation" &&
    liveText === localText &&
    liveHasListPages &&
    localHasListPages &&
    !localUnsupportedDiagnostic
  ) {
    return {
      classification: "tabview-bootstrap-safety-preservation",
      disposition: "none",
      rationale:
        "The complete projected DOM and visible text match after only replacing Wikidot's exact per-instance legacy YUI loader and initializer with Wikijump's inert bootstrap placeholder. This is an intentional script-execution safety boundary, not an implementation-complete raw match.",
    };
  }
  const liveHtmlBlockNonce = normalizeSynchronizedRuntimeFixtures(
    liveNodes,
    { normalizeHtmlBlockNonce: true },
  );
  const localHtmlBlockNonce = normalizeSynchronizedRuntimeFixtures(
    localNodes,
    { normalizeHtmlBlockNonce: true },
  );
  if (
    liveHtmlBlockNonce.state.htmlBlocks > 0 &&
    liveHtmlBlockNonce.state.htmlBlocks ===
      localHtmlBlockNonce.state.htmlBlocks &&
    liveHtmlBlockNonce.state.invalidHtmlBlocks === 0 &&
    localHtmlBlockNonce.state.invalidHtmlBlocks === 0 &&
    JSON.stringify(liveHtmlBlockNonce.nodes) ===
      JSON.stringify(localHtmlBlockNonce.nodes)
  ) {
    return {
      classification: "canonical-html-block-route-nonce",
      disposition: "none",
      rationale:
        "The selected-page HTML iframe uses the canonical single-page route grammar and its exact SHA-1 content identity, attributes, and placement match; only the unsaved PagePreview request's page-route identity and per-render decimal nonce differ.",
    };
  }
  const liveFeaturedFixture = normalizeSynchronizedRuntimeFixtures(
    liveNodes,
    {
      normalizeFeaturedSite: true,
      normalizeSocialNonce: true,
      normalizeHtmlBlockNonce: true,
    },
  );
  const localFeaturedFixture = normalizeSynchronizedRuntimeFixtures(
    localNodes,
    {
      normalizeFeaturedSite: true,
      normalizeSocialNonce: true,
      normalizeHtmlBlockNonce: true,
    },
  );
  if (
    liveFeaturedFixture.state.featuredSites > 0 &&
    liveFeaturedFixture.state.featuredSites ===
      localFeaturedFixture.state.featuredSites &&
    liveFeaturedFixture.state.invalidFeaturedSites === 0 &&
    localFeaturedFixture.state.invalidFeaturedSites === 0 &&
    liveFeaturedFixture.state.socialWidgets ===
      localFeaturedFixture.state.socialWidgets &&
    liveFeaturedFixture.state.socialScripts ===
      liveFeaturedFixture.state.socialWidgets &&
    localFeaturedFixture.state.socialScripts ===
      localFeaturedFixture.state.socialWidgets &&
    liveFeaturedFixture.state.invalidSocialWidgets === 0 &&
    localFeaturedFixture.state.invalidSocialWidgets === 0 &&
    liveFeaturedFixture.state.htmlBlocks ===
      localFeaturedFixture.state.htmlBlocks &&
    liveFeaturedFixture.state.invalidHtmlBlocks === 0 &&
    localFeaturedFixture.state.invalidHtmlBlocks === 0 &&
    JSON.stringify(liveFeaturedFixture.nodes) ===
      JSON.stringify(localFeaturedFixture.nodes)
  ) {
    return {
      classification: "rotating-featured-site-state",
      disposition: "none",
      rationale:
        "Both runtimes emit the complete canonical FeaturedSite, legacy social-widget, and selected HTML-block structures; only the rotating live site record, synchronized local author provenance, and per-render social or iframe route nonces differ.",
    };
  }

  const exactErrors = new Map([
    ["Invalid range argument.", ["invalid-range-error", "fix"]],
    ["Invalid pagetype attribute.", ["invalid-pagetype-error", "fix"]],
    ["Invalid rating argument.", ["invalid-rating-error", "fix"]],
    ["Invalid votes argument.", ["invalid-votes-error", "fix"]],
  ]);
  if (exactErrors.has(liveText)) {
    const [classification, disposition] = exactErrors.get(liveText);
    return {
      classification,
      disposition,
      rationale: "Live Wikidot emits a deterministic ListPages argument error.",
    };
  }
  if (/^Parent page .+ does not exist$/u.test(liveText)) {
    return {
      classification: "missing-parent-error",
      disposition: "fix",
      rationale: "Live Wikidot resolves the static parent and reports that it does not exist.",
    };
  }
  if (missingLineArgument !== null) {
    return {
      classification: "prepend-append-line-divergence",
      disposition: "investigate-renderer",
      rationale:
        "Live Wikidot renders an authored prependLine or appendLine value that Wikijump omits.",
    };
  }
  if (missingAuthoredSection !== null) {
    return {
      classification: "listpages-section-template-divergence",
      disposition: "investigate-renderer",
      rationale:
        `Live Wikidot renders the authored ${missingAuthoredSection.section} section text that Wikijump omits.`,
    };
  }
  if (liveHasListPages && localUnsupportedDiagnostic) {
    return {
      classification: "local-listpages-unsupported-diagnostic",
      disposition: "investigate-renderer",
      rationale:
        "Live Wikidot executes ListPages while Wikijump emits its unsupported-module diagnostic.",
    };
  }
  if (
    !source.includes("[[/module]]") &&
    /\[\[module\s+ListPages\b[^\n]*\]\]/iu.test(source) &&
    liveHasListPages &&
    localPreservedModule
  ) {
    return {
      classification: "unclosed-listpages-body-parser-gap",
      disposition: "investigate-parser",
      rationale: "Live executes a complete ListPages opening head without a closing module tag.",
    };
  }
  if (liveHasListPages && localPreservedModule) {
    return {
      classification: "live-parser-accepts-local-preserves",
      disposition: "minimize-parser",
      rationale: "Live executes the module while Wikijump leaves its source literal.",
    };
  }
  if (
    invocation !== null &&
    invocationExpectsWrapper(invocation) === true &&
    liveHasListPages &&
    localHasListPages &&
    localOutputIsLiveOutputWithoutGeneratedWrapper(
      liveNodes,
      liveTopLevelWrappers,
      localNodes,
    )
  ) {
    return {
      classification: "listpages-render-shape-divergence",
      disposition: "investigate-renderer",
      rationale:
        "Live Wikidot and Wikijump disagree on the deterministic ListPages wrapper structure.",
    };
  }
  if (liveHasListPages && localHasListPages) {
    return {
      classification: "listpages-query-or-row-render-divergence",
      disposition: "investigate-query-or-renderer",
      rationale:
        "Both runtimes execute ListPages, but no synchronized-fixture proof explains the query result or rendered-row difference.",
    };
  }
  if (liveHasListPages) {
    return {
      classification: "listpages-render-shape-divergence",
      disposition: "investigate-renderer",
      rationale: "Live emits a ListPages container while the local canonical DOM does not.",
    };
  }
  return {
    classification: "other-preview-divergence",
    disposition: "investigate",
    rationale: "The preview mismatch is not explained by a known argument, parser, or fixture-state class.",
  };
}

export async function classifyListPagesPreviewDifferential({
  verdictPath,
  referencesPath,
  authoritative = false,
  observeRuntime = observeListPagesRuntimeAuthority,
  verdictData = null,
  referencesData = null,
}) {
  const verdictText = verdictData === null
    ? await fs.readFile(verdictPath, "utf8")
    : JSON.stringify(verdictData);
  const verdict = verdictData ?? JSON.parse(verdictText);
  const referencesText = referencesData ??
    await fs.readFile(referencesPath, "utf8");
  const references = readJsonlText(referencesText).map(validateWikidotReference);
  let authority = {
    mode: "diagnostic",
    completion_eligible: false,
  };
  if (authoritative) {
    if (
      verdict.inputs?.authority?.mode !== "authoritative" ||
      verdict.inputs.authority.completion_eligible !== true
    ) {
      throw new Error(
        "authoritative classification requires an authoritative preview verdict",
      );
    }
    if (verdict.inputs.references_sha256 !== sha256(referencesText)) {
      throw new Error("live references changed after the preview verdict");
    }
    const authorityArtifacts = {};
    for (const [kind, pathField, hashField] of [
      [
        "runtime identity",
        "runtime_identity_path",
        "runtime_identity_sha256",
      ],
      ["runtime proof", "runtime_proof_path", "runtime_proof_sha256"],
    ]) {
      const inputPath = verdict.inputs[pathField];
      const inputHash = verdict.inputs[hashField];
      if (
        typeof inputPath !== "string" ||
        !/^[0-9a-f]{64}$/u.test(inputHash ?? "")
      ) {
        throw new Error(`authoritative preview verdict has no ${kind} binding`);
      }
      const currentText = await fs.readFile(inputPath, "utf8");
      if (sha256(currentText) !== inputHash) {
        throw new Error(`${kind} changed after the preview verdict`);
      }
      authorityArtifacts[kind] = JSON.parse(currentText);
    }
    const runtimeIdentity = validateListPagesRuntimeIdentity(
      authorityArtifacts["runtime identity"],
    );
    const runtimeProof = validateListPagesRuntimeProof(
      authorityArtifacts["runtime proof"],
      runtimeIdentity,
    );
    const beforeObservation = validateListPagesRuntimeObservation(
      verdict.runtime_observations?.before,
      "before",
      runtimeIdentity,
      runtimeProof,
    );
    const afterObservation = validateListPagesRuntimeObservation(
      verdict.runtime_observations?.after,
      "after",
      runtimeIdentity,
      runtimeProof,
    );
    if (
      verdict.schema !== LISTPAGES_PREVIEW_DIFFERENTIAL_SCHEMA ||
      sha256(JSON.stringify(beforeObservation)) !==
        verdict.inputs.authority.runtime_observation_before_sha256 ||
      sha256(JSON.stringify(afterObservation)) !==
        verdict.inputs.authority.runtime_observation_after_sha256 ||
      beforeObservation.stable_sha256 !== afterObservation.stable_sha256 ||
      afterObservation.stable_sha256 !==
        verdict.inputs.authority.runtime_observation_stable_sha256 ||
      !/^[0-9a-f]{64}$/u.test(
        verdict.inputs.authority.runtime_observation_before_sha256 ?? "",
      ) ||
      !/^[0-9a-f]{64}$/u.test(
        verdict.inputs.authority.runtime_observation_after_sha256 ?? "",
      ) ||
      !/^[0-9a-f]{64}$/u.test(
        verdict.inputs.authority.runtime_observation_stable_sha256 ?? "",
      )
    ) {
      throw new Error("authoritative preview verdict schema or runtime observations are invalid");
    }
    const currentObservation = validateListPagesRuntimeObservation(
      await observeRuntime({
        identity: runtimeIdentity,
        proof: runtimeProof,
        phase: "classification",
      }),
      "classification",
      runtimeIdentity,
      runtimeProof,
    );
    if (currentObservation.stable_sha256 !== afterObservation.stable_sha256) {
      throw new Error(
        "authoritative runtime changed after the preview verdict",
      );
    }
    authority = {
      mode: "authoritative",
      completion_eligible: true,
      runtime_identity_sha256: verdict.inputs.runtime_identity_sha256,
      runtime_proof_sha256: verdict.inputs.runtime_proof_sha256,
      runtime_observation_stable_sha256:
        verdict.inputs.authority.runtime_observation_stable_sha256,
    };
  }
  const referenceIds = new Set();
  for (const reference of references) {
    const caseId = reference.syntax_case.case_id;
    if (referenceIds.has(caseId)) {
      throw new Error(`duplicate live reference case ID ${caseId}`);
    }
    referenceIds.add(caseId);
  }
  const referencesById = new Map(
    references.map((reference) => [reference.syntax_case.case_id, reference]),
  );
  if (!Array.isArray(verdict.cases)) {
    throw new Error("preview verdict cases must be an array");
  }
  const verdictIds = new Set();
  for (const row of verdict.cases) {
    if (verdictIds.has(row.case_id)) {
      throw new Error(`duplicate verdict case ID ${row.case_id}`);
    }
    verdictIds.add(row.case_id);
  }
  const missing = [...referenceIds].filter((caseId) => !verdictIds.has(caseId));
  const extra = [...verdictIds].filter((caseId) => !referenceIds.has(caseId));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      [
        "verdict/reference case IDs differ",
        missing.length > 0 ? `missing ${missing.join(", ")}` : null,
        extra.length > 0 ? `extra ${extra.join(", ")}` : null,
      ].filter(Boolean).join(": "),
    );
  }

  const cases = verdict.cases.map((row) => {
    const reference = referencesById.get(row.case_id);
    if (authoritative) {
      if (
        row.schema !== `${LISTPAGES_PREVIEW_DIFFERENTIAL_SCHEMA}.case` ||
        !["match", "mismatch", "local-error"].includes(row.status)
      ) {
        throw new Error(`authoritative verdict case ${row.case_id} is invalid`);
      }
      if (row.status !== "local-error") {
        if (
          typeof row.local?.raw_html !== "string" ||
          row.local.html_sha256 !== sha256(row.local.raw_html) ||
          row.local.visible_text !== localVisibleText(row.local.raw_html) ||
          row.live?.html_sha256 !== reference.raw_html_sha256 ||
          row.live.visible_text !== visibleText(reference.raw_html)
        ) {
          throw new Error(
            `authoritative verdict local or live output is invalid for ${row.case_id}`,
          );
        }
        const expectedComparison = compareListPagesPreviewHtml(
          reference,
          row.local.raw_html,
        );
        if (
          JSON.stringify(row.comparison) !== JSON.stringify(expectedComparison) ||
          row.status !== expectedComparison.status
        ) {
          throw new Error(
            `authoritative verdict comparison is invalid for ${row.case_id}`,
          );
        }
      }
    }
    const identities = row.comparison?.identities;
    if (
      identities?.source_sha256 === undefined ||
      identities?.live_html_sha256 === undefined
    ) {
      throw new Error(`verdict missing identity for ${row.case_id}`);
    }
    if (identities.source_sha256 !== reference.source_sha256) {
      throw new Error(`verdict source identity differs for ${row.case_id}`);
    }
    if (identities.live_html_sha256 !== reference.raw_html_sha256) {
      throw new Error(`verdict live HTML identity differs for ${row.case_id}`);
    }
    const result = row.status === "match"
      ? {
          classification: "matched",
          disposition: "none",
          rationale: "Canonical DOM and visible text match.",
        }
      : row.status === "local-error"
        ? {
            classification: "local-preview-error",
            disposition: "fix-or-block",
            rationale: row.error,
          }
        : classifyMismatch(row, reference);
    return {
      schema: `${LISTPAGES_PREVIEW_CLASSIFICATION_SCHEMA}.case`,
      case_id: row.case_id,
      source: reference.syntax_case.source,
      source_sha256: reference.source_sha256,
      differential_status: row.status,
      live_html_sha256: reference.raw_html_sha256,
      local_html_sha256: row.local?.html_sha256 ?? null,
      ...result,
    };
  });

  const counts = {};
  const dispositions = {};
  for (const row of cases) {
    counts[row.classification] = (counts[row.classification] ?? 0) + 1;
    dispositions[row.disposition] = (dispositions[row.disposition] ?? 0) + 1;
  }
  if (authoritative) {
    const verdictCounts = {};
    for (const row of verdict.cases) {
      verdictCounts[row.status] = (verdictCounts[row.status] ?? 0) + 1;
    }
    const expectedExitCode =
      (verdictCounts.mismatch ?? 0) > 0 ||
        (verdictCounts["local-error"] ?? 0) > 0
        ? 1
        : 0;
    if (
      verdict.summary?.total !== verdict.cases.length ||
      JSON.stringify(verdict.summary.counts) !== JSON.stringify(verdictCounts) ||
      verdict.summary.exit_code !== expectedExitCode
    ) {
      throw new Error("authoritative preview verdict summary is invalid");
    }
  }
  return {
    schema: LISTPAGES_PREVIEW_CLASSIFICATION_SCHEMA,
    generated_at: new Date().toISOString(),
    inputs: {
      verdict_path: verdictPath,
      verdict_sha256: sha256(verdictText),
      references_path: referencesPath,
      references_sha256: sha256(referencesText),
      authority,
    },
    cases,
    summary: {
      total: cases.length,
      classifications: counts,
      dispositions,
    },
  };
}

export async function writeListPagesPreviewClassification(
  classification,
  outputPath,
) {
  await publishListPagesJsonNoReplace(outputPath, classification);
}
