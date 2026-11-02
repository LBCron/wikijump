import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import net from "node:net";
import test from "node:test";

import {
  probePublishedPostgres,
  waitForPublishedPostgres,
} from "../src/postgres-published-readiness.mjs";

const SSL_REQUEST = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);
const AUTH_REQUEST = Buffer.from([0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00]);
const isSslRequest = (chunk) => chunk.length === 8 && chunk[4] === 0x04;
const PROBE_TIMEOUT_MS = 10_000;

function errorResponse(message) {
  const fields = [["S", "FATAL"], ["C", "57P03"], ["M", message]];
  const body = Buffer.concat([
    ...fields.flatMap(([code, text]) => [Buffer.from(code), Buffer.from(text), Buffer.from([0])]),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(5);
  header[0] = 0x45;
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

function startupProtocol(message) {
  assert.ok(message.length >= 8);
  assert.equal(message.readInt32BE(0), message.length);
  return message.readInt32BE(4);
}

async function listen(handler) {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    handler(socket);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  return {server, port: address.port};
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

class ScriptedSocket extends EventEmitter {
  constructor(respond) {
    super();
    this.respond = respond;
    this.destroyed = false;
  }

  setTimeout() {
    return this;
  }

  write(chunk) {
    const request = Buffer.from(chunk);
    process.nextTick(() => {
      if (!this.destroyed) this.respond(this, request);
    });
    return true;
  }

  destroy() {
    this.destroyed = true;
    return this;
  }
}

test("published PostgreSQL probe waits for a query-ready startup response", async () => {
  const requests = [];
  const {server, port} = await listen((socket) => {
    socket.on("data", (chunk) => {
      requests.push(chunk);
      if (isSslRequest(chunk)) {
        socket.write(Buffer.from("N"));
        return;
      }
      socket.end(AUTH_REQUEST);
    });
  });
  try {
    assert.equal(await probePublishedPostgres({port, timeoutMs: PROBE_TIMEOUT_MS}), "N");
    assert.deepEqual(requests[0], SSL_REQUEST);
    assert.equal(startupProtocol(requests[1]), 196608);
    assert.match(requests[1].toString("utf8"), /user\0wikijump\0database\0wikijump\0\0$/u);
  } finally {
    await close(server);
  }
});

test("published PostgreSQL probe assembles a fragmented startup response", async () => {
  const {server, port} = await listen((socket) => {
    socket.on("data", (chunk) => {
      if (!isSslRequest(chunk)) return;
      socket.write(Buffer.from("N"));
      socket.write(AUTH_REQUEST.subarray(0, 3));
      setTimeout(() => socket.end(AUTH_REQUEST.subarray(3)), 5);
    });
  });
  try {
    assert.equal(await probePublishedPostgres({port, timeoutMs: PROBE_TIMEOUT_MS}), "N");
  } finally {
    await close(server);
  }
});

test("published PostgreSQL probe rejects an SSL-enabled server without sending plaintext startup", async () => {
  const requests = [];
  const {server, port} = await listen((socket) => {
    socket.on("data", (chunk) => {
      requests.push(chunk);
      if (isSslRequest(chunk)) socket.end(Buffer.from("S"));
    });
  });
  try {
    await assert.rejects(
      probePublishedPostgres({port, timeoutMs: PROBE_TIMEOUT_MS}),
      /offered SSL.*requires a plaintext task-owned database/u,
    );
    assert.deepEqual(requests, [SSL_REQUEST]);
  } finally {
    await close(server);
  }
});

test("published PostgreSQL readiness retries a still-recovering database", async () => {
  let connections = 0;
  const {server, port} = await listen((socket) => {
    connections += 1;
    const connection = connections;
    let responded = false;
    socket.on("data", (chunk) => {
      if (isSslRequest(chunk)) {
        if (connection === 1) {
          responded = true;
          socket.end(Buffer.concat([Buffer.from("N"), errorResponse("the database system is starting up")]));
          return;
        }
        socket.write(Buffer.from("N"));
        return;
      }
      if (!responded) {
        responded = true;
        socket.end(AUTH_REQUEST);
      }
    });
  });
  try {
    assert.equal(await waitForPublishedPostgres({port, attempts: 3, intervalMs: 1, timeoutMs: PROBE_TIMEOUT_MS}), "N");
    assert.equal(connections, 2);
  } finally {
    await close(server);
  }
});

test("published PostgreSQL probe surfaces the recovery error", async () => {
  const {server, port} = await listen((socket) => {
    socket.on("data", (chunk) => {
      if (!isSslRequest(chunk)) return;
      socket.end(Buffer.concat([Buffer.from("N"), errorResponse("the database system is starting up")]));
    });
  });
  try {
    await assert.rejects(
      probePublishedPostgres({port, timeoutMs: PROBE_TIMEOUT_MS}),
      /PostgreSQL is not ready: the database system is starting up/u,
    );
  } finally {
    await close(server);
  }
});

test("published PostgreSQL readiness retries an invalid first protocol response", async () => {
  let connections = 0;
  const {server, port} = await listen((socket) => {
    connections += 1;
    const connection = connections;
    let responded = false;
    socket.on("data", (chunk) => {
      if (isSslRequest(chunk)) {
        if (connection === 1) {
          responded = true;
          socket.end(Buffer.from([0x00]));
          return;
        }
        socket.write(Buffer.from("N"));
        return;
      }
      if (!responded) {
        responded = true;
        socket.end(AUTH_REQUEST);
      }
    });
  });
  try {
    assert.equal(await waitForPublishedPostgres({port, attempts: 3, intervalMs: 1, timeoutMs: PROBE_TIMEOUT_MS}), "N");
    assert.equal(connections, 2);
  } finally {
    await close(server);
  }
});

test("published PostgreSQL readiness retries a host-path timeout", async (t) => {
  const attempts = [
    (socket) => socket.emit("timeout"),
    (socket, request) => socket.emit("data", isSslRequest(request) ? Buffer.from("N") : AUTH_REQUEST),
  ];
  const sockets = [];
  t.mock.method(net, "createConnection", () => {
    const respond = attempts[sockets.length];
    assert.ok(respond, `unexpected readiness connection ${sockets.length + 1}`);
    const socket = new ScriptedSocket(respond);
    sockets.push(socket);
    process.nextTick(() => socket.emit("connect"));
    return socket;
  });
  assert.equal(await waitForPublishedPostgres({port: 5432, attempts: 3, intervalMs: 1, timeoutMs: 20}), "N");
  assert.equal(sockets.length, 2);
});

test("published PostgreSQL probe rejects a non-protocol byte", async () => {
  const {server, port} = await listen((socket) => {
    socket.once("data", () => socket.end(Buffer.from([0x00])));
  });
  try {
    await assert.rejects(
      probePublishedPostgres({port, timeoutMs: PROBE_TIMEOUT_MS}),
      /unexpected PostgreSQL SSLRequest response: 0x00/u,
    );
  } finally {
    await close(server);
  }
});
