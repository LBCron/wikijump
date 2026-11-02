import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCorpusImportManifest,
  buildManifestSummary,
  formatJsonl,
  summarizeIncludeClosure,
} from "../src/corpus-import-manifest.mjs";
import {
  expandCrossSiteIncludeClosure,
  expandIncludeClosure,
  includeTargetSlug,
  parseIncludeTargets,
} from "../src/corpus-include-closure.mjs";
import { parseArgs } from "../scripts/build-corpus-import-manifest.mjs";
import { writePage } from "./support/corpus-import-manifest-fixture.mjs";

const sourceReader = (sources) => ({
  readSource: (slug) => (slug in sources ? sources[slug] : null),
  pageExists: (slug) => slug in sources,
});

test("includeTargetSlug matches the drift reporter contract", () => {
  assert.equal(includeTargetSlug(":scp-wiki:theme:basalt", "scp-wiki"), "theme:basalt");
  assert.equal(includeTargetSlug(":SCP-WIKI:Component:Preview", "scp-wiki"), "component:preview");
  assert.equal(includeTargetSlug("component:license-box", "scp-wiki"), "component:license-box");
  assert.equal(includeTargetSlug(":scp-jp:theme:x", "scp-wiki"), null);
  assert.equal(includeTargetSlug("{$theme}", "scp-wiki"), null);
  assert.equal(includeTargetSlug("component:license-box@@", "scp-wiki"), null);
});

test("parseIncludeTargets separates same-site, external, and dynamic targets", () => {
  const targets = parseIncludeTargets(
    [
      "[[include info:start]]",
      "[[include :scp-wiki:info:more]]",
      "[[include :scpsandbox2:hippo]]",
      "[[include :SCP-WIKI:Info:End]]",
      "[[include {$theme}]]",
      "@@[[include component:documented]]@@",
      "[!-- [[include component:hidden]] --]",
    ].join("\n"),
    "scp-wiki",
  );
  assert.deepEqual(targets.sameSite, ["info:start", "info:more", "info:end"]);
  assert.deepEqual(targets.external, ["scpsandbox2:hippo"]);
  assert.equal(targets.dynamic, 1);
});

test("expandIncludeClosure walks transitively, roots first, once per page", () => {
  const sources = {
    "scp-1": "[[include :scp-wiki:theme:basalt]]\n[[include component:a |x=1]]",
    "theme:basalt": "[[include component:interwiki-style]]\n@@[[include component:a@@]]",
    "component:a": "[[include :scp-wiki:component:b]]\n[[include theme:basalt]]",
    "component:b": "plain",
    "component:interwiki-style": "[[include :other-site:component:c]]",
  };
  const closure = expandIncludeClosure({ roots: ["scp-1"], ...sourceReader(sources), sourceSite: "scp-wiki" });
  assert.deepEqual(closure.included.map((page) => page.slug), [
    "scp-1",
    "theme:basalt",
    "component:a",
    "component:interwiki-style",
    "component:b",
  ]);
  assert.deepEqual(closure.included.map((page) => page.depth), [0, 1, 1, 2, 2]);
  assert.equal(closure.included[1].via, "scp-1");
  assert.deepEqual(closure.unresolved, []);
  assert.deepEqual(closure.external, ["other-site:component:c"]);
  assert.equal(closure.dynamic, 0);
  assert.deepEqual(closure.truncated, []);
});

test("expandIncludeClosure reports unresolved and dynamic targets without failing", () => {
  const closure = expandIncludeClosure({
    roots: ["scp-1"],
    ...sourceReader({
      "scp-1": "[[include component:gone]]\n[[include {$name}]]\n[[include :scp-wiki:component:gone]]",
    }),
    sourceSite: "scp-wiki",
  });
  assert.deepEqual(closure.included.map((page) => page.slug), ["scp-1"]);
  assert.deepEqual(closure.unresolved, ["component:gone"]);
  assert.equal(closure.dynamic, 1);
});

test("expandIncludeClosure reports a present-but-sourceless page as unresolved", () => {
  const closure = expandIncludeClosure({
    roots: ["scp-1"],
    readSource: (slug) => (slug === "scp-1" ? "[[include component:phantom]]" : null),
    pageExists: (slug) => slug === "scp-1" || slug === "component:phantom",
    sourceSite: "scp-wiki",
  });
  assert.deepEqual(closure.included.map((page) => page.slug), [
    "scp-1",
    "component:phantom",
  ]);
  assert.deepEqual(closure.unresolved, ["component:phantom"]);
});

test("expandIncludeClosure does not report a sourceless root as unresolved", () => {
  const closure = expandIncludeClosure({
    roots: ["scp-1"],
    readSource: () => null,
    pageExists: () => true,
    sourceSite: "scp-wiki",
  });
  assert.deepEqual(closure.included.map((page) => page.slug), ["scp-1"]);
  assert.deepEqual(closure.unresolved, []);
});

test("expandIncludeClosure still records external targets met at maxDepth", () => {
  const closure = expandIncludeClosure({
    roots: ["scp-1"],
    ...sourceReader({
      "scp-1": "[[include component:a]]",
      "component:a": "[[include :other-site:shared]]\n[[include :other-site:shared]]",
    }),
    sourceSite: "scp-wiki",
    maxDepth: 1,
  });
  assert.deepEqual(closure.included.map((page) => page.slug), ["scp-1", "component:a"]);
  assert.deepEqual(closure.external, ["other-site:shared"]);
  assert.deepEqual(closure.truncated, []);
});

test("expandIncludeClosure truncates past maxDepth and bounds total pages", () => {
  const sources = {
    "scp-1": "[[include component:a]]",
    "component:a": "[[include component:b]]",
    "component:b": "plain",
  };
  const shallow = expandIncludeClosure({
    roots: ["scp-1"],
    ...sourceReader(sources),
    sourceSite: "scp-wiki",
    maxDepth: 1,
  });
  assert.deepEqual(shallow.included.map((page) => page.slug), ["scp-1", "component:a"]);
  assert.deepEqual(shallow.truncated, ["component:b"]);

  assert.throws(
    () => expandIncludeClosure({ roots: ["scp-1"], ...sourceReader(sources), sourceSite: "scp-wiki", maxPages: 1 }),
    /maxPages/u,
  );
  assert.throws(
    () => expandIncludeClosure({ roots: [], ...sourceReader(sources), sourceSite: "scp-wiki" }),
    /at least one root/u,
  );
});

function writeClosureCorpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-closure-"));
  const pages = {
    "scp-3352": "[[include :scp-wiki:info:start]]\n[[include :scpsandbox2:hippo]]\nbody",
    "info:start": "[[include info:more]]\nstart",
    "info:more": "more",
  };
  let counter = 0;
  for (const [fullname, source] of Object.entries(pages)) {
    counter += 1;
    writePage(root, "en", fullname, {
      entityId: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
      source,
    });
  }
  return root;
}

test("buildCorpusImportManifest expands the include closure and annotates rows", () => {
  const root = writeClosureCorpus();
  const rows = buildCorpusImportManifest({
    corpusRoot: root,
    branch: "en",
    sourceSite: "scp-wiki",
    sourceBranch: "en",
    fullnames: ["scp-3352"],
    includeClosure: {},
  });
  assert.deepEqual(rows.map((row) => row.fullname), ["info:more", "info:start", "scp-3352"]);
  const byName = new Map(rows.map((row) => [row.fullname, row]));
  assert.equal(byName.get("scp-3352").closure_depth, 0);
  assert.equal(byName.get("scp-3352").closure_via, null);
  assert.equal(byName.get("info:start").closure_depth, 1);
  assert.equal(byName.get("info:start").closure_via, "scp-3352");
  assert.equal(byName.get("info:more").closure_depth, 2);
  assert.equal(byName.get("info:more").closure_via, "info:start");
  const summary = summarizeIncludeClosure(
    expandIncludeClosure({
      roots: ["scp-3352"],
      readSource: (slug) => {
        const sourcePath = path.join(root, "en", "pages", slug, "source.wikidot.txt");
        return fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, "utf8") : null;
      },
      pageExists: (slug) => fs.existsSync(path.join(root, "en", "pages", slug, "source.wikidot.txt")),
      sourceSite: "scp-wiki",
    }),
  );
  assert.equal(summary.included_count, 3);
  assert.equal(summary.added_count, 2);
  assert.equal(summary.max_depth, 2);
  assert.deepEqual(summary.unresolved, []);
  assert.deepEqual(summary.external, ["scpsandbox2:hippo"]);
  const manifestSummary = buildManifestSummary(rows, formatJsonl(rows));
  assert.equal(manifestSummary.row_count, 3);
});

test("buildCorpusImportManifest fails closed on unresolved closure targets", () => {
  const root = writeClosureCorpus();
  writePage(root, "en", "scp-1", {
    entityId: "00000000-0000-4000-8000-000000000009",
    source: "[[include component:gone]]",
  });
  assert.throws(
    () => buildCorpusImportManifest({
      corpusRoot: root,
      branch: "en",
      sourceSite: "scp-wiki",
      fullnames: ["scp-1"],
      includeClosure: {},
    }),
    /component:gone/u,
  );
  const rows = buildCorpusImportManifest({
    corpusRoot: root,
    branch: "en",
    sourceSite: "scp-wiki",
    fullnames: ["scp-1"],
    includeClosure: { allowUnresolved: true },
  });
  assert.deepEqual(rows.map((row) => row.fullname), ["scp-1"]);
});

test("buildCorpusImportManifest rejects closure without explicit roots", () => {
  const root = writeClosureCorpus();
  assert.throws(
    () => buildCorpusImportManifest({ corpusRoot: root, branch: "en", includeClosure: {} }),
    /explicit fullnames/u,
  );
});

test("manifest CLI parses closure flags and guards their scope", () => {
  const args = parseArgs([
    "--corpus-root",
    "/corpus",
    "--fullname",
    "scp-3352",
    "--include-closure",
    "--closure-max-depth",
    "4",
    "--output",
    "/tmp/manifest.jsonl",
    "--summary",
    "/tmp/summary.json",
  ]);
  assert.equal(args.includeClosure, true);
  assert.equal(args.closureMaxDepth, 4);
  assert.throws(
    () => parseArgs(["--source-bundle", "/bundle", "--include-closure", "--output", "o", "--summary", "s"]),
    /--corpus-root/u,
  );
  assert.throws(
    () => parseArgs(["--corpus-root", "/corpus", "--include-closure", "--output", "o", "--summary", "s"]),
    /--fullname/u,
  );
  assert.throws(
    () => parseArgs(["--corpus-root", "/corpus", "--allow-unresolved-closure", "--output", "o", "--summary", "s"]),
    /require --include-closure/u,
  );
});

const crossSiteReader = (branches) => {
  const access = {};
  for (const [branch, pages] of Object.entries(branches)) {
    access[branch] = {
      pageExists: (slug) => slug in pages,
      readSource: (slug) => (slug in pages ? pages[slug] : null),
      readProvenance: (slug) => ({ path: `${branch}/pages/${slug}/source.wikidot.txt`, captureId: `${branch}-capture`, runId: `${branch}-run`, payloadSha256: null }),
    };
  }
  return access;
};

test("expandCrossSiteIncludeClosure follows foreign identities through the supplying branch", () => {
  const branches = crossSiteReader({
    en: {
      "scp-1": "[[include :snippets:comp]]\n[[include component:a]]",
      "component:a": "plain",
    },
    snippets: { comp: "[[include component:inner]]", "component:inner": "leaf" },
  });
  const closure = expandCrossSiteIncludeClosure({
    roots: [{ branch: "en", site: "scp-wiki", slug: "scp-1" }],
    branches,
  });
  assert.deepEqual(closure.included.map((page) => `${page.branch}:${page.slug}`), [
    "en:scp-1",
    "en:component:a",
    "snippets:comp",
    "snippets:component:inner",
  ]);
  assert.deepEqual(closure.included.map((page) => page.depth), [0, 1, 1, 2]);
  assert.equal(closure.included[2].site, "snippets");
  assert.equal(closure.included[2].via, "en:scp-1");
  assert.equal(closure.included[2].provenance.captureId, "snippets-capture");
  assert.deepEqual(closure.gaps, []);
  assert.deepEqual(closure.truncated, []);
});

test("expandCrossSiteIncludeClosure reports absent, ambiguous, and same-site gaps without failing", () => {
  const branches = crossSiteReader({
    en: { "scp-1": "[[include :nosuchsite:gone]]\n[[include :shared:both]]\n[[include component:missing]]" },
    aaa: { both: "leaf aaa" },
    zzz: { both: "leaf zzz" },
  });
  const closure = expandCrossSiteIncludeClosure({
    roots: [{ branch: "en", site: "scp-wiki", slug: "scp-1" }],
    branches,
  });
  assert.deepEqual(closure.gaps.map((gap) => gap.reason).sort(), ["absent-from-corpus", "absent-from-corpus", "ambiguous-branches"]);
  const byReason = Object.fromEntries(closure.gaps.map((gap) => [gap.reason + ":" + gap.identity, gap]));
  assert.equal(byReason["absent-from-corpus:nosuchsite:gone"].via, "en:scp-1");
  assert.equal(byReason["absent-from-corpus:nosuchsite:gone"].branch, null);
  assert.match(byReason["ambiguous-branches:shared:both"].detail, /divergent sources/u);
  assert.equal(byReason["absent-from-corpus:en:component:missing"].branch, "en");
  assert.deepEqual(closure.included.map((page) => page.slug), ["scp-1"]);
});

test("expandCrossSiteIncludeClosure resolves byte-identical multi-branch hits without choosing", () => {
  const branches = crossSiteReader({
    en: { "scp-1": "[[include :shared:both]]" },
    aaa: { both: "same leaf" },
    zzz: { both: "same leaf" },
  });
  const closure = expandCrossSiteIncludeClosure({
    roots: [{ branch: "en", site: "scp-wiki", slug: "scp-1" }],
    branches,
  });
  assert.deepEqual(closure.included.map((page) => `${page.branch}:${page.slug}`), ["en:scp-1", "aaa:both"]);
  assert.deepEqual(closure.included[1].also_in, ["zzz"]);
  assert.deepEqual(closure.gaps, []);
});

test("expandCrossSiteIncludeClosure terminates cross-branch cycles and honors the requesting branch", () => {
  const branches = crossSiteReader({
    en: { "scp-1": "[[include :other:loop]]" },
    other: { loop: "[[include :scp-wiki:scp-1]]\n[[include :other:loop]]" },
  });
  const closure = expandCrossSiteIncludeClosure({
    roots: [{ branch: "en", site: "scp-wiki", slug: "scp-1" }],
    branches,
  });
  assert.deepEqual(closure.included.map((page) => `${page.branch}:${page.slug}`), ["en:scp-1", "other:loop"]);
  assert.deepEqual(closure.gaps, []);
});

test("expandCrossSiteIncludeClosure never resolves a foreign identity to the requesting branch", () => {
  const branches = crossSiteReader({
    en: { "scp-1": "[[include :snippets:comp]]", comp: "wrong-site decoy" },
    snippets: { comp: "leaf" },
  });
  const closure = expandCrossSiteIncludeClosure({
    roots: [{ branch: "en", site: "scp-wiki", slug: "scp-1" }],
    branches,
  });
  assert.deepEqual(closure.included.map((page) => `${page.branch}:${page.slug}`), ["en:scp-1", "snippets:comp"]);
});

test("expandCrossSiteIncludeClosure truncates past maxDepth and validates its inputs", () => {
  const branches = crossSiteReader({
    en: { "scp-1": "[[include :snippets:comp]]" },
    snippets: { comp: "leaf [[include component:deep]]", "component:deep": "leaf" },
  });
  const closure = expandCrossSiteIncludeClosure({
    roots: [{ branch: "en", site: "scp-wiki", slug: "scp-1" }],
    branches,
    maxDepth: 1,
  });
  assert.deepEqual(closure.included.map((page) => page.slug), ["scp-1", "comp"]);
  assert.deepEqual(closure.truncated, ["snippets:component:deep"]);
  assert.throws(() => expandCrossSiteIncludeClosure({ roots: [], branches }), /at least one root/u);
  assert.throws(() => expandCrossSiteIncludeClosure({ roots: [{ branch: "en", site: "scp-wiki", slug: "x" }], branches: {} }), /at least one searchable branch/u);
  assert.throws(() => expandCrossSiteIncludeClosure({ roots: [{ branch: "nope", site: "s", slug: "x" }], branches }), /not searchable/u);
  assert.throws(() => expandCrossSiteIncludeClosure({ roots: [{ branch: "en", slug: "x" }], branches }), /branch, site, slug/u);
});

test("expandCrossSiteIncludeClosure prefers the caller-configured branch for divergent hits", () => {
  const branches = crossSiteReader({
    en: { "scp-1": "[[include :shared:both]]" },
    aaa: { both: "leaf aaa" },
    zzz: { both: "leaf zzz" },
  });
  const closure = expandCrossSiteIncludeClosure({
    roots: [{ branch: "en", site: "scp-wiki", slug: "scp-1" }],
    branches,
    preferredBranches: { shared: "zzz" },
  });
  assert.deepEqual(closure.included.map((page) => `${page.branch}:${page.slug}`), ["en:scp-1", "zzz:both"]);
  assert.equal(closure.included[1].resolution, "preferred-branch");
  assert.deepEqual(closure.included[1].also_in, ["aaa"]);
  assert.deepEqual(closure.gaps, []);
});

test("expandCrossSiteIncludeClosure resolves divergent hits to the target site's own branch by default", () => {
  const branches = crossSiteReader({
    en: { "scp-1": "[[include :scp-int:comp]]" },
    int: { comp: "leaf int" },
    es: { comp: "leaf es" },
  });
  const closure = expandCrossSiteIncludeClosure({
    roots: [{ branch: "en", site: "scp-wiki", slug: "scp-1" }],
    branches,
  });
  assert.deepEqual(closure.included.map((page) => `${page.branch}:${page.slug}`), ["en:scp-1", "int:comp"]);
  assert.equal(closure.included[1].resolution, "preferred-branch");
  assert.deepEqual(closure.included[1].also_in, ["es"]);
  assert.deepEqual(closure.gaps, []);
});

test("expandCrossSiteIncludeClosure keeps an ambiguous-branches gap for sites with no corpus branch", () => {
  const branches = crossSiteReader({
    en: { "scp-1": "[[include :scp-sandbox-3:comp]]" },
    fr: { comp: "leaf fr" },
    it: { comp: "leaf it" },
  });
  const closure = expandCrossSiteIncludeClosure({
    roots: [{ branch: "en", site: "scp-wiki", slug: "scp-1" }],
    branches,
  });
  assert.deepEqual(closure.included.map((page) => `${page.branch}:${page.slug}`), ["en:scp-1"]);
  assert.equal(closure.gaps.length, 1);
  assert.equal(closure.gaps[0].reason, "ambiguous-branches");
  assert.equal(closure.gaps[0].identity, "scp-sandbox-3:comp");
});

test("expandIncludeClosure validates its depth and page bounds", () => {
  const closures = (options) =>
    expandIncludeClosure({
      roots: ["scp-1"],
      readSource: () => "plain",
      pageExists: () => true,
      sourceSite: "scp-wiki",
      ...options,
    });
  assert.throws(() => closures({ maxDepth: -1 }), /maxDepth must be a non-negative integer/u);
  assert.throws(() => closures({ maxDepth: 1.5 }), /maxDepth must be a non-negative integer/u);
  assert.throws(() => closures({ maxPages: 0 }), /maxPages must be a positive integer/u);
  assert.equal(closures({}).included.length, 1);
});

test("expandCrossSiteIncludeClosure validates its branches map and bounds", () => {
  const branches = crossSiteReader({ en: { "scp-1": "plain" } });
  const roots = [{ branch: "en", site: "scp-wiki", slug: "scp-1" }];
  assert.throws(() => expandCrossSiteIncludeClosure({ roots, branches: null }), /branches map/u);
  assert.throws(() => expandCrossSiteIncludeClosure({ roots, branches: [] }), /branches map/u);
  assert.throws(
    () =>
      expandCrossSiteIncludeClosure({
        roots,
        branches: { en: { pageExists: () => true, readSource: () => null } },
      }),
    /must provide readProvenance/u,
  );
  assert.throws(() => expandCrossSiteIncludeClosure({ roots, branches, maxDepth: -1 }), /maxDepth/u);
  assert.throws(() => expandCrossSiteIncludeClosure({ roots, branches, maxPages: 0 }), /maxPages/u);
});

test("expandCrossSiteIncludeClosure throws past maxPages", () => {
  const branches = crossSiteReader({
    en: { "scp-1": "[[include component:a]]", "component:a": "plain" },
  });
  assert.throws(
    () =>
      expandCrossSiteIncludeClosure({
        roots: [{ branch: "en", site: "scp-wiki", slug: "scp-1" }],
        branches,
        maxPages: 1,
      }),
    /exceeds maxPages 1 at en:component:a/u,
  );
});

test("expandCrossSiteIncludeClosure gaps a sourceless page but not a sourceless root", () => {
  const provenance = () => ({ path: "en/pages/x/source.wikidot.txt", captureId: null, runId: null, payloadSha256: null });
  const gapped = expandCrossSiteIncludeClosure({
    roots: [{ branch: "en", site: "scp-wiki", slug: "scp-1" }],
    branches: {
      en: {
        pageExists: () => true,
        readSource: (slug) => (slug === "scp-1" ? "[[include component:phantom]]" : null),
        readProvenance: provenance,
      },
    },
  });
  assert.deepEqual(gapped.included.map((page) => page.slug), ["scp-1", "component:phantom"]);
  assert.deepEqual(gapped.gaps, [
    {
      identity: "en:component:phantom",
      branch: "en",
      site: "scp-wiki",
      via: "en:scp-1",
      reason: "absent-from-corpus",
      detail: "corpus branch en has no source for component:phantom",
    },
  ]);
  const rooted = expandCrossSiteIncludeClosure({
    roots: [{ branch: "en", site: "scp-wiki", slug: "scp-1" }],
    branches: {
      en: { pageExists: () => true, readSource: () => null, readProvenance: provenance },
    },
  });
  assert.deepEqual(rooted.included.map((page) => page.slug), ["scp-1"]);
  assert.deepEqual(rooted.gaps, []);
});

test("expandCrossSiteIncludeClosure records unique-hit and same-branch resolutions", () => {
  const branches = crossSiteReader({
    en: { "scp-1": "[[include :snippets:comp]]\n[[include component:a]]", "component:a": "plain" },
    snippets: { comp: "leaf" },
  });
  const closure = expandCrossSiteIncludeClosure({
    roots: [{ branch: "en", site: "scp-wiki", slug: "scp-1" }],
    branches,
  });
  const bySlug = Object.fromEntries(closure.included.map((page) => [page.slug, page]));
  assert.equal(bySlug["scp-1"].resolution, null);
  assert.equal(bySlug["component:a"].resolution, "same-branch");
  assert.equal(bySlug["comp"].resolution, "unique-hit");
});
