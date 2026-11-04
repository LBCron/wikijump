import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  guardedPipeline,
  isBlockedAddress,
  resolvePinned,
  startCaptureEgressProxy,
} from "../src/capture-egress-proxy.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

test("guarded pipeline reports a synchronous closed-stream failure instead of throwing", () => {
  const failure = new Error("destination already closed");
  let observed = null;
  assert.doesNotThrow(() => guardedPipeline({}, {}, (error) => {
    observed = error;
  }, () => {
    throw failure;
  }));
  assert.equal(observed, failure);
});

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

function proxyRequest(proxyUrl, target, { method = "GET", body = "" } = {}) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: proxy.hostname, port: proxy.port, method, path: target },
      (response) => {
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("proxy response aborted")));
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode, body: data }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

test("address policy rejects private, loopback, link-local, metadata, and invalid addresses", () => {
  for (const value of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "::1",
    "fd00::1",
    "fe80::1",
    "not-an-ip",
  ]) {
    assert.equal(isBlockedAddress(value), true, value);
  }
  assert.equal(isBlockedAddress("93.184.216.34"), false);
  assert.equal(isBlockedAddress("2606:2800:220:1:248:1893:25c8:1946"), false);
});

test("proxy pins one resolution and forwards method/body only to an exact allowed local origin", async () => {
  const upstream = await listen((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => response.end(`${request.method}:${body}`));
  });
  let lookups = 0;
  const proxy = await startCaptureEgressProxy({
    allowedLocalOrigins: [`http://fixture.test:${upstream.port}`],
    lookup: async () => {
      lookups += 1;
      return [{ address: "127.0.0.1" }];
    },
  });
  try {
    assert.deepEqual(
      await proxyRequest(
        proxy.url,
        `http://fixture.test:${upstream.port}/post`,
        { method: "POST", body: "payload" },
      ),
      { status: 200, body: "POST:payload" },
    );
    assert.equal(lookups, 1);
    assert.equal(
      (
        await proxyRequest(
          proxy.url,
          `http://fixture.test:${upstream.port + 1}/`,
        )
      ).status,
      403,
    );
  } finally {
    await proxy.close();
    await close(upstream.server);
  }
});

test("candidate proxy denies Wikidot targets before DNS or connection", async () => {
  let lookups = 0;
  const proxy = await startCaptureEgressProxy({
    allowedLocalOrigins: ["http://fixture.test:1234"],
    denyWikidotTargets: true,
    lookup: async () => {
      lookups += 1;
      return [{ address: "93.184.216.34" }];
    },
  });
  try {
    assert.equal((await proxyRequest(proxy.url, "http://www.wikidot.com/")).status, 403);
    assert.equal(lookups, 0);
  } finally {
    await proxy.close();
  }
});

test("a DNS rebinding answer is revalidated and denied before connection", async () => {
  let lookupCount = 0;
  const lookup = async () => [
    { address: ++lookupCount === 1 ? "93.184.216.34" : "127.0.0.1" },
  ];
  assert.equal(
    await resolvePinned("rebind.test", 80, { lookup }),
    "93.184.216.34",
  );
  await assert.rejects(
    resolvePinned("rebind.test", 80, { lookup }),
    /not publicly routable/u,
  );
  assert.equal(lookupCount, 2);
});

test("an aborted streamed response does not crash the proxy", async () => {
  const upstream = await listen((request, response) => {
    if (request.url === "/ok") return response.end("OK");
    response.write("first");
    setTimeout(() => response.end("second"), 25);
  });
  const proxy = await startCaptureEgressProxy({
    allowedLocalOrigins: [`http://fixture.test:${upstream.port}`],
    lookup: async () => [{ address: "127.0.0.1" }],
  });
  try {
    const proxyUrl = new URL(proxy.url);
    await new Promise((resolve, reject) => {
      const request = http.get(
        {
          host: proxyUrl.hostname,
          port: proxyUrl.port,
          path: `http://fixture.test:${upstream.port}/stream`,
        },
        (response) => {
          response.once("data", () => {
            response.destroy();
            resolve();
          });
          response.once("error", reject);
        },
      );
      request.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      await proxyRequest(proxy.url, `http://fixture.test:${upstream.port}/ok`),
      { status: 200, body: "OK" },
    );
  } finally {
    await proxy.close();
    await close(upstream.server);
  }
});

test("an upstream that never responds is bounded and denied", async () => {
  const upstream = await listen(() => {
  });
  const proxy = await startCaptureEgressProxy({
    allowedLocalOrigins: [`http://fixture.test:${upstream.port}`],
    lookup: async () => [{ address: "127.0.0.1" }],
    requestTimeoutMs: 25,
  });
  try {
    assert.deepEqual(
      await proxyRequest(proxy.url, `http://fixture.test:${upstream.port}/hang`),
      {status: 502, body: "capture egress denied\n"},
    );
  } finally {
    await proxy.close();
    await close(upstream.server);
  }
});

test("a timed-out partial upstream response closes without crashing the proxy", async () => {
  const upstream = await listen((request, response) => {
    if (request.url === "/ok") return response.end("OK");
    response.writeHead(200, {"content-type": "text/plain"});
    response.write("partial");
  });
  const proxy = await startCaptureEgressProxy({
    allowedLocalOrigins: [`http://fixture.test:${upstream.port}`],
    lookup: async () => [{address: "127.0.0.1"}],
    requestTimeoutMs: 25,
  });
  try {
    const partial = await proxyRequest(
      proxy.url,
      `http://fixture.test:${upstream.port}/partial`,
    ).catch(() => ({status: 502}));
    assert.equal(partial.status, 502);
    assert.deepEqual(
      await proxyRequest(proxy.url, `http://fixture.test:${upstream.port}/ok`),
      {status: 200, body: "OK"},
    );
  } finally {
    await proxy.close();
    await close(upstream.server);
  }
});

test("CONNECT rejects a private destination unless its exact origin is allowed", async () => {
  const proxy = await startCaptureEgressProxy();
  const address = new URL(proxy.url);
  try {
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(Number(address.port), address.hostname, () =>
        socket.write(
          "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        ),
      );
      socket.once("data", (data) => {
        resolve(data.toString());
        socket.destroy();
      });
      socket.once("error", reject);
    });
    assert.match(reply, /^HTTP\/1\.1 403/u);
  } finally {
    await proxy.close();
  }
});

test("an aborted CONNECT tunnel does not crash the proxy", async () => {
  const upstream = net.createServer((socket) => socket.on("error", () => {}));
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const proxy = await startCaptureEgressProxy({
    allowedLocalOrigins: [`https://fixture.test:${upstreamPort}`],
    lookup: async () => [{ address: "127.0.0.1" }],
  });
  const proxyUrl = new URL(proxy.url);
  try {
    await new Promise((resolve, reject) => {
      const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname, () =>
        socket.write(
          `CONNECT fixture.test:${upstreamPort} HTTP/1.1\r\nHost: fixture.test\r\n\r\n`,
        ),
      );
      socket.once("data", (data) => {
        assert.match(data.toString(), /^HTTP\/1\.1 200/u);
        if (typeof socket.resetAndDestroy === "function")
          socket.resetAndDestroy();
        else socket.destroy();
        resolve();
      });
      socket.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname, () =>
        socket.write(
          `CONNECT fixture.test:${upstreamPort} HTTP/1.1\r\nHost: fixture.test\r\n\r\n`,
        ),
      );
      socket.once("data", (data) => {
        resolve(data.toString());
        socket.destroy();
      });
      socket.once("error", reject);
    });
    assert.match(reply, /^HTTP\/1\.1 200/u);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("a normally closed CONNECT tunnel does not retain the request timeout after proxy cleanup", async () => {
  const childSource = String.raw`
    import net from "node:net";
    import { startCaptureEgressProxy } from "./install/local/wikidot-verification/src/capture-egress-proxy.mjs";

    const upstream = net.createServer((socket) => socket.on("error", () => {}));
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = upstream.address().port;
    const proxy = await startCaptureEgressProxy({
      allowedLocalOrigins: ["https://fixture.test:" + upstreamPort],
      lookup: async () => [{address: "127.0.0.1"}],
      requestTimeoutMs: 60_000,
    });
    const proxyUrl = new URL(proxy.url);
    const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname, () =>
      socket.write("CONNECT fixture.test:" + upstreamPort + " HTTP/1.1\r\nHost: fixture.test\r\n\r\n"),
    );
    socket.on("error", () => {});
    await new Promise((resolve, reject) => {
      socket.once("data", (data) => {
        try {
          if (!data.toString().startsWith("HTTP/1.1 200")) throw new Error("CONNECT did not succeed");
          socket.end();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", reject);
    });
    await new Promise((resolve) => socket.once("close", resolve));
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
    console.log("done");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({code, signal}));
  });
  let timer = null;
  try {
    const result = await Promise.race([
      exit,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("CONNECT timeout handle kept the child process alive after cleanup")), 1_000);
      }),
    ]);
    assert.deepEqual(result, {code: 0, signal: null}, stderr);
    assert.equal(stdout.trim(), "done");
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
  }
});

test("an idle CONNECT tunnel is closed after the request timeout", async () => {
  const upstream = net.createServer((socket) => socket.on("error", () => {}));
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const proxy = await startCaptureEgressProxy({
    allowedLocalOrigins: [`https://fixture.test:${upstreamPort}`],
    lookup: async () => [{address: "127.0.0.1"}],
    requestTimeoutMs: 25,
  });
  const proxyUrl = new URL(proxy.url);
  try {
    const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname, () =>
      socket.write(
        `CONNECT fixture.test:${upstreamPort} HTTP/1.1\r\nHost: fixture.test\r\n\r\n`,
      ),
    );
    socket.on("error", () => {});
    const response = await new Promise((resolve, reject) => {
      socket.once("data", (data) => resolve(data.toString()));
      socket.once("error", reject);
    });
    assert.match(response, /^HTTP\/1\.1 200/u);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("idle tunnel remained open")), 500);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("closing the proxy tears down an active CONNECT tunnel", async () => {
  const upstream = net.createServer((socket) => socket.on("error", () => {}));
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const proxy = await startCaptureEgressProxy({
    allowedLocalOrigins: [`https://fixture.test:${upstreamPort}`],
    lookup: async () => [{address: "127.0.0.1"}],
    requestTimeoutMs: 60_000,
  });
  const proxyUrl = new URL(proxy.url);
  const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname, () =>
    socket.write(
      `CONNECT fixture.test:${upstreamPort} HTTP/1.1\r\nHost: fixture.test\r\n\r\n`,
    ),
  );
  socket.on("error", () => {});
  try {
    await new Promise((resolve, reject) => {
      socket.once("data", (data) => {
        try {
          assert.match(data.toString(), /^HTTP\/1\.1 200/u);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", reject);
    });
    const closed = new Promise((resolve) => socket.once("close", resolve));
    await proxy.close();
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("proxy close left a tunnel open")), 500)),
    ]);
  } finally {
    socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("an early CONNECT reset during DNS resolution does not crash the proxy or dial upstream", async () => {
  let upstreamConnections = 0;
  const upstream = net.createServer((socket) => {
    upstreamConnections += 1;
    socket.on("error", () => {});
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  let releaseFirstLookup;
  const firstLookupStarted = Promise.withResolvers();
  let lookupCount = 0;
  const proxy = await startCaptureEgressProxy({
    allowedLocalOrigins: [`https://fixture.test:${upstreamPort}`],
    lookup: async () => {
      lookupCount += 1;
      if (lookupCount === 1) {
        firstLookupStarted.resolve();
        await new Promise((resolve) => {
          releaseFirstLookup = resolve;
        });
      }
      return [{ address: "127.0.0.1" }];
    },
  });
  const proxyUrl = new URL(proxy.url);
  try {
    const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname, () =>
      socket.write(
        `CONNECT fixture.test:${upstreamPort} HTTP/1.1\r\nHost: fixture.test\r\n\r\n`,
      ),
    );
    socket.on("error", () => {});
    await firstLookupStarted.promise;
    if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
    else socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseFirstLookup();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(upstreamConnections, 0);

    const reply = await new Promise((resolve, reject) => {
      const next = net.connect(Number(proxyUrl.port), proxyUrl.hostname, () =>
        next.write(
          `CONNECT fixture.test:${upstreamPort} HTTP/1.1\r\nHost: fixture.test\r\n\r\n`,
        ),
      );
      next.once("data", (data) => {
        resolve(data.toString());
        next.destroy();
      });
      next.once("error", reject);
    });
    assert.match(reply, /^HTTP\/1\.1 200/u);
  } finally {
    releaseFirstLookup?.();
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("proxy permits exact local subrequests and blocks a redirected local origin", async () => {
    let internalHits = 0;
    const internal = await listen((_request, response) => {
      internalHits += 1;
      response.end("INTERNAL SECRET");
    });
    const fixture = await listen((request, response) => {
      if (request.url === "/frame") return response.end("FRAME OK");
      if (request.url === "/api" && request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => response.end(`POST:${body}`));
        return;
      }
      if (request.url === "/redirect") {
        response.writeHead(302, {
          location: `http://127.0.0.1:${internal.port}/secret`,
        });
        return response.end();
      }
      response.end("ROOT");
    });
    const proxy = await startCaptureEgressProxy({
      allowedLocalOrigins: [`http://127.0.0.1:${fixture.port}`],
    });
    try {
      assert.deepEqual(
        await proxyRequest(proxy.url, `http://127.0.0.1:${fixture.port}/frame`),
        { status: 200, body: "FRAME OK" },
      );
      assert.deepEqual(
        await proxyRequest(proxy.url, `http://127.0.0.1:${fixture.port}/api`, {
          method: "POST",
          body: "x",
        }),
        { status: 200, body: "POST:x" },
      );
      assert.equal(
        (await proxyRequest(proxy.url, `http://127.0.0.1:${fixture.port}/redirect`)).status,
        302,
      );
      assert.equal(
        (await proxyRequest(proxy.url, `http://127.0.0.1:${internal.port}/secret`)).status,
        403,
      );
      assert.equal(internalHits, 0);
    } finally {
      await proxy.close();
      await close(fixture.server);
      await close(internal.server);
    }
});
