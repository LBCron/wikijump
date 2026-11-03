#!/usr/bin/env node

import process from "node:process";

import {runCliIfMain} from "../src/cli-entry.mjs";
import {
  parseStandingBrowserParityArgs,
  runStandingBrowserParity,
} from "../src/standing-browser-parity-runner.mjs";

export function usage() {
  return `Usage:
  run-standing-browser-parity.mjs --mode live-reference --output-dir DIR --live-completion-policy POLICY.json --source-response-cache-dir DIR --source-response-cache-identity ID --cache-source-documents [--browser-root DIR] [--browser-executable PATH] [--viewport WIDTHxHEIGHT] [--timeout-ms N] [--settle-ms N]
  run-standing-browser-parity.mjs --mode candidate --output-dir DIR --live-completion-policy POLICY.json [--live-reference-capture-policy POLICY.json] --candidate-port PORT --live-reference-ledger REFERENCE.json [--browser-root DIR] [--browser-executable PATH] [--viewport WIDTHxHEIGHT] [--timeout-ms N] [--settle-ms N]
  run-standing-browser-parity.mjs --mode standing --output-dir DIR --live-completion-policy POLICY.json [--live-reference-capture-policy POLICY.json] --live-reference-ledger REFERENCE.json --source-response-cache-dir DIR --source-response-cache-identity ID [--browser-root DIR] [--browser-executable PATH] [--viewport WIDTHxHEIGHT] [--timeout-ms N] [--settle-ms N]`;
}

export async function main(argv, {
  parseArgs = parseStandingBrowserParityArgs,
  runParity = runStandingBrowserParity,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout(usage());
    return 0;
  }
  try {
    const result = await runParity(parseArgs(argv));
    stdout(JSON.stringify({
      schema: "wikijump.standing_browser_parity_cli_result.v1",
      mode: result.mode,
      status: result.status,
      output_dir: result.output_dir,
    }));
    return result.status === "pass" || result.status === "sealed" ? 0 : 1;
  } catch (error) {
    stderr(JSON.stringify({
      schema: "wikijump.standing_browser_parity_cli_result.v1",
      status: "error",
      error: error?.message ?? String(error),
    }));
    return 1;
  }
}

await runCliIfMain(import.meta.url, main, {argv: process.argv});
