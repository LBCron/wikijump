import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => readFile(path.join(repositoryRoot, relative), "utf8");
const baseImage = (dockerfile) => dockerfile.match(/^FROM (\S+)$/mu)?.[1];

test("every PostgreSQL image, and the volume upgrade tool, use one server version", async () => {
  const local = await read("install/local/postgres/Dockerfile");
  const dev = await read("install/dev/postgres/Dockerfile");
  const upgrade = await read("install/common/postgres/upgrade/Dockerfile");

  assert.match(baseImage(local), /^postgres:[^@]+@sha256:[0-9a-f]{64}$/u);
  assert.equal(baseImage(dev), baseImage(local));
  assert.equal(baseImage(upgrade), baseImage(local));
});

test("the volume upgrade tool's two servers share one Alpine release", async () => {
  const upgrade = await read("install/common/postgres/upgrade/Dockerfile");
  const alpine = (image) => image.match(/-alpine(\d+\.\d+)@/u)?.[1];
  const previous = [...upgrade.matchAll(/^COPY --from=(\S+) /gmu)].map((match) => match[1]);

  assert.ok(previous.length > 0);
  for (const image of previous) assert.equal(alpine(image), alpine(baseImage(upgrade)), image);
});

test("the data directory stays at the path every topology mounts", async () => {
  for (const dockerfile of ["install/local/postgres/Dockerfile", "install/dev/postgres/Dockerfile"]) {
    assert.match(await read(dockerfile), /^ENV PGDATA=\/var\/lib\/postgresql\/data$/mu, dockerfile);
  }
});

test("the server entrypoint keeps the image's own CMD and takes the data directory lock", async () => {
  for (const dockerfile of ["install/local/postgres/Dockerfile", "install/dev/postgres/Dockerfile"]) {
    const contents = await read(dockerfile);
    assert.match(contents, /^ENTRYPOINT \["wikijump-locked-entrypoint"\]$/mu, dockerfile);
    assert.match(contents, /^CMD \["postgres"\]$/mu, dockerfile);
  }
});

test("no local stack can share a data volume or reach Standing's Caddy volumes by default", async () => {
  const compose = await read("install/local/docker-compose.yaml");
  for (const volume of ["postgres-data", "minio-data", "valkey-data"]) {
    assert.ok(compose.includes(`name: \${WIKIJUMP_LOCAL_VOLUME_NAMESPACE:-local}-${volume}`), volume);
  }
  for (const volume of ["caddy-data", "caddy-config"]) {
    assert.ok(compose.includes(`name: \${WIKIJUMP_LOCAL_VOLUME_NAMESPACE:-local}-dev-${volume}`), volume);
    assert.ok(!compose.includes(`name: local-${volume}`), volume);
  }
});
