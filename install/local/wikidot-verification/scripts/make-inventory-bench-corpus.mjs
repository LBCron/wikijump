import fs from "node:fs/promises";
import path from "node:path";

async function writePage(docsRoot, fullname, source) {
  const pageDir = path.join(docsRoot, fullname);
  await fs.mkdir(pageDir, { recursive: true });
  await fs.writeFile(path.join(pageDir, "source.wikidot.txt"), source);
  await fs.writeFile(
    path.join(pageDir, "meta.json"),
    `${JSON.stringify({ fullname, title: fullname })}\n`
  );
}

export async function makeCorpus({ docsRoot, pageCount, fanIn }) {
  const regularPages = Array.from(
    { length: pageCount },
    (_, i) => `doc-regular:page-${i}`
  );

  await writePage(
    docsRoot,
    "doc-modules:start",
    [
      ...regularPages.map((name) => `* [[[${name} | ${name}]]]`),
      ...Array.from(
        { length: fanIn },
        (_, i) => `* [[[doc-include:snippet-0 | hub ${i}]]]`
      )
    ].join("\n")
  );
  await writePage(
    docsRoot,
    "doc-modules:listpages-module",
    "[[include doc-include:snippet-0]]\n"
  );

  for (let i = 0; i < pageCount; i += 1) {
    const body = [
      `++ Module ${i}`,
      `[[include doc-include:snippet-${i % pageCount}]]`,
      "[[include doc-include:snippet-0]]",
      "[[include doc-include:snippet-0]]",
      `[[include doc-include:absent-${i}]]`,
      '[[module ListPages category="design" perPage="10"]]'
    ];
    for (let f = 1; f <= fanIn; f += 1) {
      const target = i + f;
      if (target < pageCount) body.push(`[[include doc-modules:mod-${target}]]`);
    }
    await writePage(docsRoot, `doc-modules:mod-${i}`, `${body.join("\n")}\n`);
  }
  await writePage(docsRoot, "doc-modules:leaf", "Terminal module documentation.\n");

  for (let i = 0; i < pageCount; i += 1) {
    await writePage(docsRoot, `doc-include:snippet-${i}`, `Snippet ${i} content.\n`);
  }

  return { pages: pageCount, fanIn, expectedPages: pageCount * 2 + pageCount + 3 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [docsRoot, pageCountRaw, fanInRaw] = process.argv.slice(2);
  const pageCount = Number(pageCountRaw ?? 400);
  const fanIn = Number(fanInRaw ?? 40);
  const info = await makeCorpus({ docsRoot, pageCount, fanIn });
  process.stdout.write(`${JSON.stringify({ docsRoot, ...info })}\n`);
}
