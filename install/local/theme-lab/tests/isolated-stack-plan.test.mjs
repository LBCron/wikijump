import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_VOLUMES,
  REQUIRED_SERVICES,
  UNUSED_SERVICES,
  isolatedStackOverride,
  isolatedStackProject,
  verifyIsolatedCompose,
} from "../src/isolated-stack-plan.mjs";

const namespace = "basalt-current-audit";
const project = isolatedStackProject(namespace);
const root = "/example/immutable-checkout";
const expectedVolumes = Object.fromEntries(
  ALL_VOLUMES.map((name) => [name, { name: `${project}-${name}` }]),
);
const config = {
  name: project,
  volumes: expectedVolumes,
  networks: { default: { name: `${project}_default` } },
  services: {
    database: {
      ports: [],
      build: { context: root },
      volumes: [
        {
          type: "volume",
          source: "local-postgres-data",
          target: "/var/lib/postgresql/data",
        },
      ],
    },
    cache: {
      ports: [],
      volumes: [
        { type: "volume", source: "local-valkey-data", target: "/data" },
      ],
    },
    files: {
      ports: [],
      volumes: [
        { type: "volume", source: "local-minio-data", target: "/data" },
      ],
    },
    deepwell: {
      ports: [],
      build: { context: root },
      volumes: [
        {
          type: "bind",
          source: `${root}/deepwell/src`,
          target: "/src/deepwell/src",
        },
        {
          type: "volume",
          source: "local-rust-1-99-1-target",
          target: "/src/target",
        },
      ],
    },
  },
};

test("isolation plan generates no host port publishing, shared named volumes, or accidental side services", () => {
  const override = isolatedStackOverride(namespace);
  assert.equal(
    (override.match(/ports: !reset \[\]/gu) ?? []).length,
    REQUIRED_SERVICES.length + UNUSED_SERVICES.length,
  );
  assert.equal(
    (override.match(/profiles: \[theme-lab-not-started\]/gu) ?? []).length,
    UNUSED_SERVICES.length,
  );
  for (const volume of ALL_VOLUMES)
    assert.ok(override.includes(`name: ${project}-${volume}`));
  const plan = verifyIsolatedCompose(config, { namespace, sourceRoot: root });
  assert.equal(plan.shared_named_volumes, 0);
  assert.equal(plan.published_port_count, 0);
  assert.equal(plan.expected_backend_container, `${project}-deepwell-1`);
  assert.equal(plan.expected_network, `${project}_default`);
});

test("invalid namespaces cannot target another project or previously protected storage", () => {
  for (const name of [
    "a",
    "Standing",
    "../standing",
    "task/name",
    "x".repeat(40),
    "x_legacy",
  ]) {
    assert.throws(() => isolatedStackProject(name), /namespace/u);
  }
});

test("config check rejects shared volumes, altered project, extra exposed ports, and unsafe network", () => {
  const variants = [
    { ...config, name: "wikijump-standing" },
    {
      ...config,
      volumes: {
        ...config.volumes,
        "local-valkey-data": { name: "local-valkey-data" },
      },
    },
    {
      ...config,
      volumes: {
        ...config.volumes,
        "local-valkey-data": {
          name: `${project}-local-valkey-data`,
          external: true,
        },
      },
    },
    {
      ...config,
      networks: { default: { name: `${project}_default`, external: true } },
    },
    {
      ...config,
      networks: { default: { name: "wikijump-local-development_default" } },
    },
    {
      ...config,
      services: {
        ...config.services,
        deepwell: {
          ...config.services.deepwell,
          ports: [{ published: 2747, target: 2747 }],
        },
      },
    },
    {
      ...config,
      services: {
        ...config.services,
        files: { ...config.services.files, network_mode: "host" },
      },
    },
    {
      ...config,
      services: {
        ...config.services,
        cache: {
          ...config.services.cache,
          volumes: [
            { type: "volume", source: "standing-cache", target: "/data" },
          ],
        },
      },
    },
    {
      ...config,
      services: {
        ...config.services,
        database: {
          ...config.services.database,
          build: { context: "/wrong/source" },
        },
      },
    },
    { ...config, services: { ...config.services, wws: { ports: [] } } },
    {
      ...config,
      services: {
        ...config.services,
        deepwell: {
          ...config.services.deepwell,
          volumes: [
            {
              type: "bind",
              source: "/home/roku/src/other",
              target: "/src/deepwell/src",
            },
          ],
        },
      },
    },
  ];
  for (const [index, variant] of variants.entries())
    assert.throws(
      () => verifyIsolatedCompose(variant, { namespace, sourceRoot: root }),
      Error,
      `unsafe variant ${index}`,
    );
});

test("isolated project and all named volumes are disjoint between independent tasks", () => {
  const other = "basalt-current-audit-b";
  const otherProject = isolatedStackProject(other);
  assert.notEqual(otherProject, project);
  for (const volume of ALL_VOLUMES)
    assert.notEqual(`${otherProject}-${volume}`, `${project}-${volume}`);
});
