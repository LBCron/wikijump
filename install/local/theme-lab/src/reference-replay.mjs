// Loopback replay of a cached foreign reference snapshot.
//
// The persistent Chromium reference tab loads from this server, so iteration
// after acquisition is fully local: no foreign Wikidot/WDFiles/CDN requests.

import http from "node:http";

import {fail} from "./errors.mjs";

const OBJECT_PATH = /^\/o\/([0-9a-f]{64})$/u;

export async function startReferenceReplay({cache, rootUrl, host = "127.0.0.1"}) {
  const manifest = await cache.load();
  const snapshot = manifest.snapshots[rootUrl];
  if (!snapshot) {
    fail("reference_snapshot_missing", `no cached reference snapshot for ${rootUrl}`, {url: rootUrl});
  }
  const server = http.createServer(async (request, response) => {
    const match = new URL(request.url, `http://${host}`).pathname.match(OBJECT_PATH);
    if (!match) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    const digest = match[1];
    const record = manifest.objects[digest];
    if (!record) {
      response.statusCode = 404;
      response.end("missing object");
      return;
    }
    try {
      const bytes = await cache.readObject(digest);
      response.statusCode = 200;
      response.setHeader("content-type", record.content_type ?? "application/octet-stream");
      response.setHeader("cache-control", "no-store");
      response.end(bytes);
    } catch {
      response.statusCode = 404;
      response.end("missing object");
    }
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const {port} = server.address();
  const origin = `http://${host}:${port}`;
  return {
    origin,
    entryUrl: `${origin}${snapshot.entry}`,
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections?.();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
