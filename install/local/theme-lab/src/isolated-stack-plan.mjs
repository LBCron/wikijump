// Generate a task-owned development backend without sharing any persistent
// volume or published host port with Standing or local-development. This
// plans/validates the Compose configuration; it never starts containers.
export const REQUIRED_SERVICES = Object.freeze([
  "database",
  "cache",
  "files",
  "deepwell",
]);
export const UNUSED_SERVICES = Object.freeze(["framerail", "wws", "caddy"]);
export const ALL_VOLUMES = Object.freeze([
  "local-caddy-data",
  "local-caddy-config",
  "local-postgres-data",
  "local-minio-data",
  "local-valkey-data",
  "local-rust-1-99-1-target",
  "local-rust-1-99-1-cargo-registry",
  "local-rust-1-99-1-cargo-git",
  "local-node-24-18-0-pnpm-store",
  "local-framerail-node-modules",
]);

export function isolatedStackProject(namespace) {
  if (
    typeof namespace !== "string" ||
    !/^[a-z][a-z0-9-]{2,30}$/u.test(namespace)
  )
    throw new Error(
      "isolated task namespace must be 3–31 lowercase characters",
    );
  return `wikijump-theme-lab-${namespace}`;
}

export function isolatedStackOverride(namespace) {
  const project = isolatedStackProject(namespace);
  const services = [...REQUIRED_SERVICES, ...UNUSED_SERVICES];
  return (
    `# Task-owned ephemeral Theme Lab backend; never copy Standing volumes.\nservices:\n` +
    services
      .map(
        (service) =>
          `  ${service}:\n    ports: !reset []\n` +
          (UNUSED_SERVICES.includes(service)
            ? "    profiles: [theme-lab-not-started]\n"
            : ""),
      )
      .join("") +
    `volumes:\n` +
    ALL_VOLUMES.map(
      (volume) => `  ${volume}:\n    name: ${project}-${volume}\n`,
    ).join("")
  );
}

export function verifyIsolatedCompose(config, { namespace, sourceRoot }) {
  const project = isolatedStackProject(namespace);
  if (config?.name !== project)
    throw new Error("Compose project identity differs from task namespace");
  const services = config.services;
  if (
    !services ||
    typeof services !== "object" ||
    Object.keys(services).sort().join(",") !==
      [...REQUIRED_SERVICES].sort().join(",")
  )
    throw new Error(
      "isolated backend Compose contains missing or unexpected services",
    );
  if (
    !config.networks ||
    Object.entries(config.networks).some(
      ([key, network]) =>
        network.external === true || network.name !== `${project}_${key}`,
    )
  )
    throw new Error(
      "isolated backend has a shared or externally managed network",
    );
  for (const [name, service] of Object.entries(services)) {
    if ((service.ports ?? []).length !== 0)
      throw new Error(`${name}: published host ports are forbidden`);
    if (service.network_mode === "host" || service.privileged === true)
      throw new Error(
        `${name}: host networking or privileged execution is forbidden`,
      );
    const context = service.build?.context;
    if (["deepwell", "database"].includes(name) && context !== sourceRoot)
      throw new Error(`${name}: build source is not the explicit checkout`);
    for (const volume of service.volumes ?? []) {
      if (
        volume.type === "volume" &&
        (!volume.source ||
          config.volumes?.[volume.source]?.name !==
            `${project}-${volume.source}`)
      )
        throw new Error(`${name}: volume is not task-owned: ${volume.source}`);
      if (volume.type === "bind" && !volume.source.startsWith(`${sourceRoot}/`))
        throw new Error(`${name}: source bind escapes the requested checkout`);
    }
  }
  if (
    !config.volumes ||
    Object.values(config.volumes).some(
      (vol) =>
        vol.external === true ||
        typeof vol.name !== "string" ||
        !vol.name.startsWith(`${project}-`),
    )
  )
    throw new Error("isolated backend has globally shared named volumes");
  return {
    schema: "theme_lab_isolated_backend_plan.v1",
    compose_project: project,
    source_root: sourceRoot,
    validated_services: [...REQUIRED_SERVICES],
    published_port_count: 0,
    shared_named_volumes: 0,
    expected_backend_container: `${project}-deepwell-1`,
    expected_network: `${project}_default`,
  };
}
