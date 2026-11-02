import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import {startReferenceReplay} from "../src/reference-replay.mjs";

const ROOT_URL = "https://example.invalid/page";
const ENTRY_DIGEST = "0".repeat(64);

function stubCache() {
  return {
    async load() {
      return {
        snapshots: {[ROOT_URL]: {entry: `/o/${ENTRY_DIGEST}`}},
        objects: {[ENTRY_DIGEST]: {content_type: "text/html"}},
      };
    },
    async readObject() {
      return Buffer.from("<!doctype html><title>reference</title>");
    },
  };
}

test("reference replay close does not wait for a client that never releases its connection", async () => {
  const replay = await startReferenceReplay({cache: stubCache(), rootUrl: ROOT_URL});
  const {port} = new URL(replay.origin);
  // A client that connects and holds the connection open without ever
  // finishing or closing it (the shape a browser socket pool takes when it
  // does not release a pooled connection at page teardown).
  const held = net.connect(Number(port), "127.0.0.1");
  await new Promise((resolve) => held.once("connect", resolve));
  try {
    const closed = await Promise.race([
      replay.close().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    assert.equal(closed, true, "replay close must complete even while a client holds its connection open");
  } finally {
    held.destroy();
  }
});
