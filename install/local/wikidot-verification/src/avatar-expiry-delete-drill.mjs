
export const DRILL_PROBE_PREFIX = "avatar-drill-";
export const AVATAR_CACHE_TTL_SECONDS = 60;

export const PROBE_AVATAR_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function fail(message) {
  throw new Error(`avatar drill: ${message}`);
}

function assertProbeUsername(value) {
  if (typeof value !== "string" || !/^avatar-drill-[a-z0-9-]{1,32}$/.test(value)) {
    fail(`probe username must match /^avatar-drill-[a-z0-9-]{1,32}$/, got ${JSON.stringify(value)}`);
  }
  return value;
}

function assertHttpUrl(value, what) {
  if (typeof value !== "string" || !/^https?:\/\//.test(value)) {
    fail(`${what} must be an http(s) URL, got ${JSON.stringify(value)}`);
  }
  return value.replace(/\/+$/, "");
}

export function validateDrillConfig(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    fail("config must be an object");
  }
  const probeUsername = assertProbeUsername(config.probeUsername);
  const gatewayBase = assertHttpUrl(config.gatewayBase, "gatewayBase");
  const deepwellUrl = assertHttpUrl(config.deepwellUrl, "deepwellUrl");
  if (typeof config.dbContainer !== "string" || config.dbContainer.length === 0) {
    fail("dbContainer must be a non-empty container name");
  }
  if (typeof config.cacheContainer !== "string" || config.cacheContainer.length === 0) {
    fail("cacheContainer must be a non-empty container name");
  }
  if (typeof config.operatorIp !== "string" || config.operatorIp.length === 0) {
    fail("operatorIp must be set for the audit trail");
  }
  const waitSeconds = config.waitSeconds ?? AVATAR_CACHE_TTL_SECONDS + 5;
  if (!Number.isInteger(waitSeconds) || waitSeconds <= AVATAR_CACHE_TTL_SECONDS || waitSeconds > 600) {
    fail(`waitSeconds must be an integer in (${AVATAR_CACHE_TTL_SECONDS}, 600] to outlast the avatar TTL`);
  }
  return {
    probeUsername,
    gatewayBase,
    deepwellUrl,
    dbContainer: config.dbContainer,
    cacheContainer: config.cacheContainer,
    operatorIp: config.operatorIp,
    waitSeconds,
  };
}

const ref = (step, field) => ({ $ref: `${step}.${field}` });

export function refToken(value) {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && typeof value.$ref === "string") {
    return `{{${value.$ref}}}`;
  }
  throw new Error(`avatar drill: cannot template a non-string, non-$ref value`);
}

export function resolveRefs(value, bindings, env = {}) {
  if (value !== null && typeof value === "object" && typeof value.$secret === "string") {
    const secret = env[value.$secret];
    if (!secret) throw new Error(`avatar drill: missing required secret ${value.$secret} in the environment`);
    return secret;
  }
  if (value !== null && typeof value === "object" && typeof value.$ref === "string") {
    if (!Object.hasOwn(bindings, value.$ref)) {
      throw new Error(`avatar drill: unresolved binding ${value.$ref}`);
    }
    return bindings[value.$ref];
  }
  if (typeof value === "string") {
    return value.replace(/\{\{([^{}]+)\}\}/g, (match, path) => {
      if (!Object.hasOwn(bindings, path)) {
        throw new Error(`avatar drill: unresolved template ${match}`);
      }
      const resolved = bindings[path];
      if (resolved !== null && typeof resolved === "object") {
        throw new Error(`avatar drill: cannot interpolate non-scalar binding ${path}`);
      }
      return String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, bindings, env));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveRefs(item, bindings, env)]),
    );
  }
  return value;
}

function avatarRoute(gatewayBase, userId) {
  return `${gatewayBase}/-/avatar/${refToken(userId)}`;
}

function dbHasAvatar(container, userId) {
  return {
    kind: "db",
    container,
    sql: `SELECT avatar_s3_hash IS NOT NULL AS has_avatar FROM "user" WHERE user_id = ${refToken(userId)};`,
  };
}

export function buildAvatarDrillPlan(rawConfig) {
  const config = validateDrillConfig(rawConfig);
  const { probeUsername, gatewayBase, deepwellUrl, dbContainer, cacheContainer, operatorIp, waitSeconds } = config;
  const cacheKey = (userId) => `user_avatar:${refToken(userId)}`;

  const steps = [
    {
      id: "precheck-probe-name-free",
      phase: "precheck",
      title: "Probe username is unused",
      request: {
        kind: "db",
        container: dbContainer,
        sql: `SELECT user_id FROM "user" WHERE name = '${probeUsername}';`,
      },
      expect: { rows: 0 },
    },
    {
      id: "create-probe-user",
      phase: "mutate",
      title: "Create the disposable probe account",
      request: {
        kind: "rpc",
        url: deepwellUrl,
        method: "user_create",
        params: {
          user_type: "regular",
          name: probeUsername,
          email: `${probeUsername}@gmail.com`,
          locales: ["en"],
          password: { $secret: "AVATAR_DRILL_PROBE_PASSWORD" },
          ip_address: operatorIp,
        },
      },
      expect: { field: "user_id", type: "integer" },
    },
    {
      id: "assert-no-avatar-at-rest",
      phase: "assert",
      title: "Probe starts with no avatar row",
      request: dbHasAvatar(dbContainer, ref("create-probe-user", "user_id")),
      expect: { has_avatar: false },
    },
    {
      id: "assert-route-404-before-avatar",
      phase: "assert",
      title: "Avatar route 404s with no avatar",
      request: { kind: "http", method: "GET", url: avatarRoute(gatewayBase, ref("create-probe-user", "user_id")) },
      expect: { status: 404 },
    },
    {
      id: "assert-cache-empty-before-avatar",
      phase: "assert",
      title: "No cache entry before the first serve",
      request: { kind: "cache", container: cacheContainer, command: ["GET", cacheKey(ref("create-probe-user", "user_id"))] },
      expect: { value: null },
    },
    {
      id: "presign-avatar-upload",
      phase: "mutate",
      title: "Presign the probe avatar blob",
      request: {
        kind: "rpc",
        url: deepwellUrl,
        method: "blob_upload",
        params: {
          user_id: ref("create-probe-user", "user_id"),
          blob_size: PROBE_AVATAR_PNG.length,
          scope: "unscoped",
        },
      },
      expect: { field: "pending_blob_id", type: "string" },
    },
    {
      id: "upload-avatar-bytes",
      phase: "mutate",
      title: "PUT the probe avatar bytes",
      request: {
        kind: "http",
        method: "PUT",
        url: ref("presign-avatar-upload", "presign_url"),
        headers: { "content-type": "image/png" },
        body: "PROBE_AVATAR_PNG",
      },
      expect: { status: 200 },
    },
    {
      id: "set-avatar",
      phase: "mutate",
      title: "Associate the avatar with the probe account",
      request: {
        kind: "rpc",
        url: deepwellUrl,
        method: "user_edit",
        params: {
          user: ref("create-probe-user", "user_id"),
          avatar_uploaded_blob_id: ref("presign-avatar-upload", "pending_blob_id"),
          ip_address: operatorIp,
        },
      },
      expect: { rpc: "ok" },
    },
    {
      id: "assert-avatar-row-present",
      phase: "assert",
      title: "Avatar row stored",
      request: dbHasAvatar(dbContainer, ref("create-probe-user", "user_id")),
      expect: { has_avatar: true },
    },
    {
      id: "assert-route-200-after-avatar",
      phase: "assert",
      title: "Avatar route serves the probe avatar",
      request: { kind: "http", method: "GET", url: avatarRoute(gatewayBase, ref("create-probe-user", "user_id")) },
      expect: { status: 200, contentType: "image/", minLength: 1 },
    },
    {
      id: "assert-cache-bounded-ttl",
      phase: "assert",
      title: "Cache entry exists with a bounded TTL (the expiry acceptance)",
      request: {
        kind: "cache",
        container: cacheContainer,
        command: ["GET", cacheKey(ref("create-probe-user", "user_id"))],
        ttlOf: true,
      },
      expect: { present: true, ttlSeconds: { min: 1, max: AVATAR_CACHE_TTL_SECONDS } },
    },
    {
      id: "wait-out-avatar-ttl",
      phase: "wait",
      title: `Wait ${waitSeconds}s with no avatar requests (the live expiry)`,
      request: { kind: "wait", seconds: waitSeconds },
      expect: { elapsed: true },
    },
    {
      id: "assert-cache-expired",
      phase: "assert",
      title: "Cache entry is gone without any delete",
      request: { kind: "cache", container: cacheContainer, command: ["GET", cacheKey(ref("create-probe-user", "user_id"))] },
      expect: { value: null },
    },
    {
      id: "assert-route-recaches",
      phase: "assert",
      title: "Route re-serves and re-caches after expiry",
      request: { kind: "http", method: "GET", url: avatarRoute(gatewayBase, ref("create-probe-user", "user_id")) },
      expect: { status: 200, contentType: "image/", minLength: 1 },
    },
    {
      id: "remove-avatar",
      phase: "mutate",
      title: "Remove the avatar (the delete-on-change path)",
      request: {
        kind: "rpc",
        url: deepwellUrl,
        method: "user_edit",
        params: {
          user: ref("create-probe-user", "user_id"),
          avatar_uploaded_blob_id: null,
          ip_address: operatorIp,
        },
      },
      expect: { rpc: "ok" },
    },
    {
      id: "assert-row-cleared",
      phase: "assert",
      title: "Avatar row cleared",
      request: dbHasAvatar(dbContainer, ref("create-probe-user", "user_id")),
      expect: { has_avatar: false },
    },
    {
      id: "assert-cache-dropped-on-remove",
      phase: "assert",
      title: "Cache entry dropped by the removal, not by expiry",
      request: { kind: "cache", container: cacheContainer, command: ["GET", cacheKey(ref("create-probe-user", "user_id"))] },
      expect: { value: null },
    },
    {
      id: "assert-route-404-after-remove",
      phase: "assert",
      title: "Avatar route stops serving the removed avatar",
      request: { kind: "http", method: "GET", url: avatarRoute(gatewayBase, ref("create-probe-user", "user_id")) },
      expect: { status: 404 },
    },
  ];

  const cleanup = [
    {
      id: "cleanup-remove-avatar",
      phase: "cleanup",
      title: "Best-effort avatar removal (idempotent)",
      request: {
        kind: "rpc",
        url: deepwellUrl,
        method: "user_edit",
        params: {
          user: ref("create-probe-user", "user_id"),
          avatar_uploaded_blob_id: null,
          ip_address: operatorIp,
        },
      },
      expect: { rpc: "ok-or-missing-user" },
    },
    {
      id: "cleanup-delete-probe-user",
      phase: "cleanup",
      title: "Delete the disposable probe account",
      request: {
        kind: "rpc",
        url: deepwellUrl,
        method: "user_delete",
        params: { user: ref("create-probe-user", "user_id"), ip_address: operatorIp },
      },
      expect: { rpc: "ok-or-missing-user" },
    },
    {
      id: "cleanup-assert-gone",
      phase: "cleanup",
      title: "Probe fully gone: no row, no route, no cache entry",
      request: {
        kind: "checklist",
        db: {
          container: dbContainer,
          sql: `SELECT user_id FROM "user" WHERE user_id = ${refToken(ref("create-probe-user", "user_id"))};`,
        },
        http: {
          method: "GET",
          url: avatarRoute(gatewayBase, ref("create-probe-user", "user_id")),
        },
        cache: {
          container: cacheContainer,
          command: ["GET", cacheKey(ref("create-probe-user", "user_id"))],
        },
      },
      expect: { gone: true },
    },
  ];

  return { probeUsername, steps, cleanup };
}

export function summarizeDrillPlan(plan) {
  const lines = [
    "avatar expiry and delete drill plan (NOT RUN — dry run; no mutations performed)",
    `probe: ${plan.probeUsername}`,
    "",
  ];
  for (const step of [...plan.steps, ...plan.cleanup]) {
    lines.push(`[${step.phase}] ${step.id}: ${step.title}`);
    lines.push(`    request: ${JSON.stringify(step.request)}`);
    lines.push(`    expect: ${JSON.stringify(step.expect)}`);
  }
  lines.push("", "cleanup always runs, even when a step fails.");
  return `${lines.join("\n")}\n`;
}
