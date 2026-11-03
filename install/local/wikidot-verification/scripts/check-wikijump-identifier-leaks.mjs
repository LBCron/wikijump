#!/usr/bin/env node

import {runCliIfMain} from "../src/cli-entry.mjs";
import {DeepwellJsonRpcClient} from "../src/deepwell-jsonrpc-client.mjs";
import {
  CONSTRUCT_BATTERY,
  runWikijumpIdentifierLeakCheck,
} from "../src/wikijump-identifier-leak.mjs";

const DEFAULT_RPC_URL = "http://127.0.0.1:2747/jsonrpc";

export function usage() {
  return [
    "Usage: check-wikijump-identifier-leaks.mjs --site SLUG [--rpc-url URL] [--json]",
    "",
    "Renders a battery of wikitext constructs through the local Deepwell runtime in",
    "Wikidot layout and fails if any Wikijump-internal identifier reaches the output.",
    "Imported themes select on Wikidot's own names, so a leaked `wj-` class is both a",
    "DOM difference and an element with no styling at all.",
    "",
    `The battery covers ${CONSTRUCT_BATTERY.length} constructs. A construct that fails to render counts as a`,
    "failure, because a render error hides whatever it would have emitted.",
    "",
    "This needs a running local stack. It renders through anonymous page preview and",
    "creates no page, so it mutates nothing.",
  ].join("\n");
}

export function parseArgs(argv) {
  const args = {rpcUrl: DEFAULT_RPC_URL, site: null, json: false};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--") continue;
    if (option === "--help" || option === "-h") return {help: true};
    if (option === "--json") {
      args.json = true;
      continue;
    }
    if (option === "--rpc-url" || option === "--site") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
      if (option === "--rpc-url") args.rpcUrl = value;
      else args.site = value;
      continue;
    }
    throw new Error(`unknown option: ${option}`);
  }
  if (!args.site) throw new Error("--site is required");
  assertLoopbackRpcUrl(args.rpcUrl);
  return args;
}

export function assertLoopbackRpcUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--rpc-url is not a URL");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error("--rpc-url must be loopback HTTP without credentials");
  }
  return url;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const client = new DeepwellJsonRpcClient({rpcUrl: args.rpcUrl});
  const site = await client.call("site_get", {site: args.site});
  if (!Number.isSafeInteger(site?.site_id)) {
    throw new Error(`local site lookup did not return a site_id for ${args.site}`);
  }
  const report = await runWikijumpIdentifierLeakCheck({
    render: async (construct) => {
      const preview = await client.call("wikidot_page_preview", {
        site_id: site.site_id,
        title: construct.id,
        wikitext: construct.wikitext,
      });
      if (typeof preview?.body !== "string") {
        throw new Error("local preview returned no body");
      }
      return preview.body;
    },
  });

  if (args.json) {
    console.log(JSON.stringify({...report, site_id: site.site_id}, null, 2));
    return report.status === "clean" ? 0 : 1;
  }

  console.log(`rendered ${report.case_count} constructs against site ${args.site}`);
  if (report.status === "clean") {
    console.log("no Wikijump identifiers reached the Wikidot layout");
    return 0;
  }
  for (const entry of report.cases) {
    if (entry.status === "leaked") {
      console.log(`  ${entry.id}: ${entry.identifiers.join(" ")}`);
    } else if (entry.status === "render-error") {
      console.log(`  ${entry.id}: did not render (${entry.error})`);
    }
  }
  console.log(
    [
      "",
      "Imported content must carry Wikidot's own names. Fix this in FTML by",
      "branching the construct on Layout::Wikidot, which is where the syntax",
      "renderer can own the result, rather than by adding another Deepwell",
      "post-render rewrite.",
    ].join("\n"),
  );
  return 1;
}

await runCliIfMain(import.meta.url, main, {
  onError: (error) => {
    console.error(error.message);
    return 2;
  },
});
