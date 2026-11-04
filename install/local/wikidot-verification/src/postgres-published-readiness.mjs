import net from "node:net";

const POSTGRES_SSL_REQUEST = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);
const POSTGRES_PROTOCOL_VERSION = 196608;
const POSTGRES_STARTUP_PARAMS = "user\0wikijump\0database\0wikijump\0\0";

// The postmaster answers SSLRequest before recovery has finished, and only
// rejects the first real query with "the database system is starting up". Send
// a StartupMessage after "N" so readiness means "accepts queries", then wait
// for AuthenticationRequest or ReadyForQuery; an ErrorResponse keeps the retry
// loop waiting instead of letting a shard fail on a still-recovering server.
function startupMessage() {
  const params = Buffer.from(POSTGRES_STARTUP_PARAMS, "utf8");
  const message = Buffer.alloc(8 + params.length);
  message.writeInt32BE(message.length, 0);
  message.writeInt32BE(POSTGRES_PROTOCOL_VERSION, 4);
  params.copy(message, 8);
  return message;
}

function errorResponseMessage(body) {
  let index = 0;
  while (index < body.length) {
    const field = body[index];
    index += 1;
    if (field === 0) break;
    const end = body.indexOf(0, index);
    if (end === -1) break;
    if (field === 0x4d) return body.toString("utf8", index, end);
    index = end + 1;
  }
  return "unspecified server error";
}

export function probePublishedPostgres({
  host = "127.0.0.1",
  port,
  timeoutMs = 500,
} = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid PostgreSQL readiness port: ${port}`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid PostgreSQL readiness timeout: ${timeoutMs}`);
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host, port});
    let settled = false;
    let phase = "ssl";
    let buffered = Buffer.alloc(0);

    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    };

    const consumeStartup = () => {
      while (buffered.length >= 5) {
        const type = String.fromCharCode(buffered[0]);
        const length = buffered.readInt32BE(1);
        if (length < 4) {
          finish(new Error(`invalid PostgreSQL startup message length: ${length}`));
          return;
        }
        if (buffered.length < 1 + length) return;
        const body = buffered.subarray(5, 1 + length);
        buffered = buffered.subarray(1 + length);
        // AuthenticationRequest and ReadyForQuery both prove the server has
        // left recovery; ParameterStatus/BackendKeyData/Notice are passive.
        if (type === "R" || type === "Z") {
          finish(undefined, "N");
          return;
        }
        if (type === "E") {
          finish(new Error(`PostgreSQL is not ready: ${errorResponseMessage(body)}`));
          return;
        }
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.write(POSTGRES_SSL_REQUEST));
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (phase === "ssl") {
        if (buffered.length < 1) return;
        const response = buffered[0];
        buffered = buffered.subarray(1);
        // "S" selects TLS. It does not prove query readiness, and sending the
        // plaintext StartupMessage after it would violate the wire protocol.
        // This probe intentionally supports only plaintext task-owned stacks.
        if (response === 0x53) {
          finish(new Error(
            "PostgreSQL offered SSL, but this readiness probe requires a plaintext task-owned database",
          ));
          return;
        }
        if (response !== 0x4e) {
          const display = `0x${response.toString(16).padStart(2, "0")}`;
          finish(new Error(`unexpected PostgreSQL SSLRequest response: ${display}`));
          return;
        }
        phase = "startup";
        socket.write(startupMessage());
      }
      consumeStartup();
    });
    socket.once("timeout", () => finish(new Error(`PostgreSQL readiness check timed out after ${timeoutMs}ms`)));
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("PostgreSQL readiness connection ended before the server was ready")));
  });
}

export async function waitForPublishedPostgres({
  host = "127.0.0.1",
  port,
  attempts = 60,
  intervalMs = 250,
  timeoutMs = 500,
} = {}) {
  if (!Number.isInteger(attempts) || attempts <= 0) {
    throw new Error(`invalid PostgreSQL readiness attempt count: ${attempts}`);
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 0) {
    throw new Error(`invalid PostgreSQL readiness interval: ${intervalMs}`);
  }

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await probePublishedPostgres({host, port, timeoutMs});
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts && intervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }
  throw new Error(
    `published PostgreSQL ${host}:${port} did not become query-ready: ${lastError?.message ?? "unknown error"}`,
  );
}
