#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {inspectCandidateAssets, materializeCandidateCssAssets} from "../../src/local-assets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const output = process.argv[2];
if (!output) throw new Error("usage: node build.mjs /absolute/output.wikidot.txt");
const css = await fs.readFile(path.join(here, "candidate.css"), "utf8");
const source = await fs.readFile(path.join(here, "candidate.wikidot.txt"), "utf8");
const shell = await fs.readFile(path.join(here, "theme-shell.wikidot.txt"), "utf8");
const assets = await inspectCandidateAssets(css, path.join(here, "assets"));
if (assets.missing.length > 0) throw new Error(`missing assets: ${assets.missing.join(", ")}`);
const inlineCss = await materializeCandidateCssAssets(css, path.join(here, "assets"));
const combined = `[[module CSS]]\n${inlineCss}\n[[/module]]\n\n${source}`;
const themeOnly = `[[module CSS]]\n${inlineCss}\n[[/module]]\n\n${shell}`;
if (combined.includes("./assets/") || /https?:\/\/(?:scpko\.|fastly\.)/u.test(inlineCss)) {
  throw new Error("combined theme still has an external or unresolved CSS asset");
}
await fs.mkdir(path.dirname(path.resolve(output)), {recursive: true});
await fs.writeFile(output, combined, "utf8");
const themeOutput = path.resolve(output).replace(/\.wikidot\.txt$/u, "-theme.wikidot.txt");
if (themeOutput === path.resolve(output)) throw new Error("output must end in .wikidot.txt");
await fs.writeFile(themeOutput, themeOnly, "utf8");
process.stdout.write(`${JSON.stringify({
  demo: {output: path.resolve(output), bytes: Buffer.byteLength(combined), sha256: crypto.createHash("sha256").update(combined).digest("hex")},
  theme: {output: themeOutput, bytes: Buffer.byteLength(themeOnly), sha256: crypto.createHash("sha256").update(themeOnly).digest("hex")},
  assets: assets.referenced,
})}\n`);
