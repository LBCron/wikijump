import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

import {
  isPlainObject,
  requireNonEmptyString,
  requirePlainObject,
  requireSha256,
  sha256Value,
} from "./standing-browser-parity-util.mjs";

const execFileAsync = promisify(execFile);

export const STANDING_CANDIDATE_RUNTIME_OBSERVATION_SCHEMA =
  "wikijump.standing_candidate_runtime_observation.v1";

const RUNTIME_LABELS = Object.freeze({
  project: "com.docker.compose.project",
  owner: "com.rokurolize.wikijump.owner",
  wikijumpCommit: "com.rokurolize.wikijump.sha",
  wikijumpTree: "com.rokurolize.wikijump.tree",
  ftmlSha: "com.rokurolize.wikijump.ftml_sha",
  artifactKey: "com.rokurolize.wikijump.artifact_key",
  configSha256: "com.rokurolize.wikijump.config_sha256",
  effectiveRuntimeServicesSha256:
    "com.rokurolize.wikijump.runtime_config_sha256",
  profile: "com.rokurolize.wikijump.profile",
  expiry: "com.rokurolize.wikijump.expires_at",
  role: "com.rokurolize.wikijump.role",
});

const COMPOSE_LABEL_PREFIX = "com.docker.compose.";

function requireGitObject(value, name) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${name} must be a full lowercase Git object id`);
  }
  return value;
}

function requireIsoTimestamp(value, name) {
  const timestamp = requireNonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${name} must be an ISO-8601 timestamp`);
  }
  return timestamp;
}

function requireImageId(value, name) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${name} must be an immutable sha256 image id`);
  }
  return value;
}

function expectedRuntimeLabels(identity, role) {
  return Object.freeze({
    [RUNTIME_LABELS.project]: identity.candidate.compose_project,
    [RUNTIME_LABELS.owner]: identity.candidate.owner,
    [RUNTIME_LABELS.wikijumpCommit]: identity.candidate.wikijump_commit,
    [RUNTIME_LABELS.wikijumpTree]: identity.candidate.wikijump_tree,
    [RUNTIME_LABELS.ftmlSha]: identity.candidate.ftml_sha,
    [RUNTIME_LABELS.artifactKey]: identity.artifact_key,
    [RUNTIME_LABELS.configSha256]:
      identity.candidate.config.isolated_overlay_sha256,
    [RUNTIME_LABELS.effectiveRuntimeServicesSha256]:
      identity.candidate.config.effective_runtime_services_sha256,
    [RUNTIME_LABELS.profile]: identity.candidate.profile,
    [RUNTIME_LABELS.expiry]: identity.candidate.expires_at,
    [RUNTIME_LABELS.role]: role,
  });
}

function requireMatchingLabels(value, identity, role) {
  const labels = requirePlainObject(
    value,
    `candidate ${role} container labels`,
  );
  const expected = expectedRuntimeLabels(identity, role);
  const observed = {};
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (labels[name] !== expectedValue) {
      throw new Error(
        `candidate ${role} runtime label ${name} does not bind the sealed identity`,
      );
    }
    observed[name] = expectedValue;
  }
  return Object.freeze(observed);
}

function inspectLabels(inspect, role) {
  const config = requirePlainObject(
    inspect.Config,
    `candidate ${role} container Config`,
  );
  return requirePlainObject(
    config.Labels,
    `candidate ${role} container Config.Labels`,
  );
}

function inspectImage(inspect, role) {
  return requireImageId(inspect?.Image, `candidate ${role} container image`);
}

function inspectContainerId(inspect, role) {
  const id = requireNonEmptyString(
    inspect?.Id,
    `candidate ${role} container ID`,
  );
  if (!/^[0-9a-f]{64}$/u.test(id)) {
    throw new Error(
      `candidate ${role} container ID must be a full lowercase Docker id`,
    );
  }
  return id;
}

function requireRunning(inspect, role) {
  const state = requirePlainObject(
    inspect?.State,
    `candidate ${role} container state`,
  );
  if (state.Running !== true) {
    throw new Error(`candidate ${role} container is not running`);
  }
  if (state.Health?.Status !== "healthy") {
    throw new Error(`candidate ${role} container is not healthy`);
  }
  return Object.freeze({
    running: true,
    status: requireNonEmptyString(
      state.Status,
      `candidate ${role} container state status`,
    ),
    health: "healthy",
  });
}

function exactPublishedBinding(inspect, binding, message) {
  const ports = requirePlainObject(inspect?.NetworkSettings?.Ports, `candidate ${binding.role} container NetworkSettings.Ports`);
  const published = ports[binding.container_port];
  const matching = Array.isArray(published)
    ? published.filter((candidate) => isPlainObject(candidate) && candidate.HostIp === binding.host_address && candidate.HostPort === String(binding.host_port))
    : [];
  if (matching.length !== 1 || published.length !== 1) throw new Error(message);
  return Object.freeze({ container_port: binding.container_port, host_address: binding.host_address, host_port: binding.host_port });
}

function exactLoopbackBinding(inspect, identity) {
  return exactPublishedBinding(inspect, {
    role: "caddy",
    container_port: "443/tcp",
    host_address: identity.candidate.endpoint.local_connect_address,
    host_port: identity.candidate.endpoint.port,
  }, "candidate caddy HTTPS publication does not exactly bind the non-443 loopback endpoint");
}

function normalizeRequiredServiceBindings(value, identity) {
  if (!Array.isArray(value)) {
    throw new Error("required service bindings must be an array");
  }
  const bindings = value.map((rawBinding, index) => {
    const binding = requirePlainObject(
      rawBinding,
      `required service binding ${index}`,
    );
    const role = requireNonEmptyString(
      binding.role,
      `required service binding ${index} role`,
    );
    if (!Object.hasOwn(identity.candidate.images, role)) {
      throw new Error(`required service binding has unknown role ${role}`);
    }
    const containerPort = requireNonEmptyString(
      binding.container_port,
      `required service binding ${index} container port`,
    );
    if (!/^[1-9][0-9]{0,4}\/(?:tcp|udp)$/u.test(containerPort)) {
      throw new Error("required service binding container port is invalid");
    }
    const hostAddress = requireNonEmptyString(
      binding.host_address,
      `required service binding ${index} host address`,
    );
    const family = net.isIP(hostAddress);
    if (
      !(
        (family === 4 && hostAddress.startsWith("127.")) ||
        (family === 6 && hostAddress === "::1")
      )
    ) {
      throw new Error("required service binding host must be loopback");
    }
    if (
      !Number.isInteger(binding.host_port) ||
      binding.host_port <= 0 ||
      binding.host_port > 65_535
    ) {
      throw new Error("required service binding host port is invalid");
    }
    return Object.freeze({
      role,
      container_port: containerPort,
      host_address: hostAddress,
      host_port: binding.host_port,
    });
  });
  bindings.sort((left, right) =>
    `${left.role}\0${left.container_port}`.localeCompare(
      `${right.role}\0${right.container_port}`,
    ),
  );
  if (
    new Set(
      bindings.map((binding) => `${binding.role}\0${binding.container_port}`),
    ).size !== bindings.length
  ) {
    throw new Error("required service bindings contain a duplicate");
  }
  return Object.freeze(bindings);
}

function exactRequiredServiceBinding(inspect, binding) {
  return exactPublishedBinding(inspect, binding, `candidate ${binding.role} required service publication does not exactly bind ${binding.container_port} to its private loopback endpoint`);
}

function bindingsForRole(bindings, role) {
  return bindings.filter((binding) => binding.role === role);
}

function normalizeRecordedRequiredBindings(service, bindings) {
  const expected = bindings.map(({ container_port, host_address, host_port }) => ({ container_port, host_address, host_port }));
  if (sha256Value(service.required_bindings) !== sha256Value(expected)) throw new Error(`candidate ${service.role} required service bindings do not match the requested private endpoints`);
  return Object.freeze(expected);
}

function safeRuntimeValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(safeRuntimeValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, safeRuntimeValue(value[key])]),
    );
  }
  return null;
}

function sortedRuntimeArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(safeRuntimeValue)
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function orderedRuntimeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(safeRuntimeValue);
}

function sortedRuntimeEnvironment(value, role) {
  const environment = orderedRuntimeArray(value);
  const names = new Set();
  for (const entry of environment) {
    if (typeof entry !== "string") continue;
    const name = entry.split("=", 1)[0];
    if (names.has(name)) throw new Error(`candidate ${role} container Config.Env has duplicate variable ${name}`);
    names.add(name);
  }
  return environment.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function selectedRuntimeLabels(labels) {
  const selected = Object.fromEntries(
    Object.entries(labels).filter(
      ([name]) => !name.startsWith(COMPOSE_LABEL_PREFIX),
    ),
  );
  delete selected[RUNTIME_LABELS.effectiveRuntimeServicesSha256];
  return safeRuntimeValue(selected);
}

function effectiveServiceConfiguration(inspect, role) {
  const config = requirePlainObject(
    inspect?.Config,
    `candidate ${role} container Config`,
  );
  const hostConfig = requirePlainObject(
    inspect?.HostConfig,
    `candidate ${role} container HostConfig`,
  );
  const networkSettings = requirePlainObject(
    inspect?.NetworkSettings,
    `candidate ${role} container NetworkSettings`,
  );
  return {
    role,
    path: requireNonEmptyString(
      inspect?.Path,
      `candidate ${role} container path`,
    ),
    args: safeRuntimeValue(inspect?.Args ?? []),
    config: {
      image: requireNonEmptyString(
        config.Image,
        `candidate ${role} configured image`,
      ),
      entrypoint: safeRuntimeValue(config.Entrypoint ?? null),
      cmd: safeRuntimeValue(config.Cmd ?? null),
      env: sortedRuntimeEnvironment(config.Env, role),
      working_dir: safeRuntimeValue(config.WorkingDir ?? null),
      user: safeRuntimeValue(config.User ?? null),
      hostname: safeRuntimeValue(config.Hostname ?? null),
      healthcheck: safeRuntimeValue(config.Healthcheck ?? null),
      exposed_ports: safeRuntimeValue(config.ExposedPorts ?? {}),
      labels: selectedRuntimeLabels(
        requirePlainObject(config.Labels, `candidate ${role} labels`),
      ),
    },
    host_config: safeRuntimeValue({
      binds: sortedRuntimeArray(hostConfig.Binds),
      mounts: orderedRuntimeArray(hostConfig.Mounts),
      network_mode: hostConfig.NetworkMode ?? null,
      cgroup: hostConfig.Cgroup ?? null,
      cgroup_parent: hostConfig.CgroupParent ?? null,
      cgroupns_mode: hostConfig.CgroupnsMode ?? null,
      ipc_mode: hostConfig.IpcMode ?? null,
      pid_mode: hostConfig.PidMode ?? null,
      uts_mode: hostConfig.UTSMode ?? null,
      userns_mode: hostConfig.UsernsMode ?? null,
      port_bindings: hostConfig.PortBindings ?? {},
      restart_policy: hostConfig.RestartPolicy ?? null,
      auto_remove: hostConfig.AutoRemove ?? false,
      readonly_rootfs: hostConfig.ReadonlyRootfs ?? false,
      tmpfs: hostConfig.Tmpfs ?? {},
      cap_add: sortedRuntimeArray(hostConfig.CapAdd),
      cap_drop: sortedRuntimeArray(hostConfig.CapDrop),
      group_add: safeRuntimeValue(hostConfig.GroupAdd ?? []),
      devices: safeRuntimeValue(hostConfig.Devices ?? []),
      device_cgroup_rules: safeRuntimeValue(hostConfig.DeviceCgroupRules ?? []),
      device_requests: safeRuntimeValue(hostConfig.DeviceRequests ?? []),
      privileged: hostConfig.Privileged ?? false,
      security_opt: sortedRuntimeArray(hostConfig.SecurityOpt),
      extra_hosts: orderedRuntimeArray(hostConfig.ExtraHosts),
      dns: orderedRuntimeArray(hostConfig.Dns),
      dns_options: orderedRuntimeArray(hostConfig.DnsOptions),
      dns_search: orderedRuntimeArray(hostConfig.DnsSearch),
      sysctls: safeRuntimeValue(hostConfig.Sysctls ?? {}),
      ulimits: safeRuntimeValue(hostConfig.Ulimits ?? []),
      shm_size: hostConfig.ShmSize ?? 0,
      runtime: hostConfig.Runtime ?? null,
      isolation: hostConfig.Isolation ?? null,
      init: hostConfig.Init ?? false,
      init_path: hostConfig.InitPath ?? null,
      oom_score_adj: hostConfig.OomScoreAdj ?? 0,
      oom_kill_disable: hostConfig.OomKillDisable ?? false,
      pids_limit: hostConfig.PidsLimit ?? null,
      memory: hostConfig.Memory ?? 0,
      memory_reservation: hostConfig.MemoryReservation ?? 0,
      memory_swap: hostConfig.MemorySwap ?? 0,
      memory_swappiness: hostConfig.MemorySwappiness ?? null,
      cpu_shares: hostConfig.CpuShares ?? 0,
      cpu_period: hostConfig.CpuPeriod ?? 0,
      cpu_quota: hostConfig.CpuQuota ?? 0,
      cpu_realtime_period: hostConfig.CpuRealtimePeriod ?? 0,
      cpu_realtime_runtime: hostConfig.CpuRealtimeRuntime ?? 0,
      cpuset_cpus: hostConfig.CpusetCpus ?? null,
      cpuset_mems: hostConfig.CpusetMems ?? null,
      cpu_count: hostConfig.CpuCount ?? 0,
      cpu_percent: hostConfig.CpuPercent ?? 0,
      blkio_weight: hostConfig.BlkioWeight ?? 0,
      blkio_weight_device: safeRuntimeValue(hostConfig.BlkioWeightDevice ?? []),
      blkio_device_read_bps: safeRuntimeValue(hostConfig.BlkioDeviceReadBps ?? []),
      blkio_device_read_iops: safeRuntimeValue(hostConfig.BlkioDeviceReadIOps ?? []),
      blkio_device_write_bps: safeRuntimeValue(hostConfig.BlkioDeviceWriteBps ?? []),
      blkio_device_write_iops: safeRuntimeValue(hostConfig.BlkioDeviceWriteIOps ?? []),
      masked_paths: safeRuntimeValue(hostConfig.MaskedPaths ?? []),
      readonly_paths: safeRuntimeValue(hostConfig.ReadonlyPaths ?? []),
    }),
    mounts: sortedRuntimeArray(
      (Array.isArray(inspect?.Mounts) ? inspect.Mounts : []).map((mount) => ({
        type: mount?.Type ?? null,
        name: mount?.Name ?? null,
        source: mount?.Source ?? null,
        destination: mount?.Destination ?? null,
        mode: mount?.Mode ?? null,
        rw: mount?.RW ?? null,
        propagation: mount?.Propagation ?? null,
      })),
    ),
    networks: safeRuntimeValue(
      Object.fromEntries(
        Object.entries(networkSettings.Networks ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, network]) => [
            name,
            {
              aliases: Array.isArray(network?.Aliases)
                ? [...network.Aliases].sort()
                : [],
            },
          ]),
      ),
    ),
  };
}

function effectiveRuntimeServiceConfigurations(inspections) {
  if (!Array.isArray(inspections) || inspections.length === 0) {
    throw new Error(
      "candidate runtime configuration requires at least one inspected service",
    );
  }
  const configurations = inspections
    .map((inspect) => {
      const role = inspect?.Config?.Labels?.[RUNTIME_LABELS.role];
      const checkedRole = requireNonEmptyString(role, "candidate runtime role");
      return {
        role: checkedRole,
        effective_configuration_sha256: sha256Value(
          effectiveServiceConfiguration(inspect, checkedRole),
        ),
      };
    })
    .sort((left, right) => left.role.localeCompare(right.role));
  if (
    new Set(configurations.map((configuration) => configuration.role)).size !==
    configurations.length
  ) {
    throw new Error("candidate runtime configuration has duplicate roles");
  }
  return configurations;
}

export function effectiveRuntimeServicesSha256(inspections) {
  return sha256Value(effectiveRuntimeServiceConfigurations(inspections));
}

function normalizedServices(identity, inspections, requiredServiceBindings = []) {
  const requiredBindings = normalizeRequiredServiceBindings(
    requiredServiceBindings,
    identity,
  );
  const expectedRoles = Object.keys(identity.candidate.images).sort();
  const services = [];
  const seenRoles = new Set();
  for (const inspect of inspections) {
    const rawLabels = inspect?.Config?.Labels;
    const role = rawLabels?.[RUNTIME_LABELS.role];
    if (
      typeof role !== "string" ||
      !Object.hasOwn(identity.candidate.images, role)
    ) {
      throw new Error(
        "candidate runtime contains an unrecognized container role",
      );
    }
    if (seenRoles.has(role)) {
      throw new Error(
        `candidate runtime has more than one container for role ${role}`,
      );
    }
    seenRoles.add(role);
    const labels = requireMatchingLabels(
      inspectLabels(inspect, role),
      identity,
      role,
    );
    const imageId = inspectImage(inspect, role);
    if (imageId !== identity.candidate.images[role]) {
      throw new Error(
        `candidate ${role} image does not bind the sealed candidate identity`,
      );
    }
    const roleBindings = bindingsForRole(requiredBindings, role);
    services.push({
      role,
      container_id: inspectContainerId(inspect, role),
      image_id: imageId,
      state: requireRunning(inspect, role),
      labels,
      ...(role === "caddy"
        ? { https_binding: exactLoopbackBinding(inspect, identity) }
        : {}),
      ...(roleBindings.length === 0 ? {} : { required_bindings: roleBindings.map((binding) => exactRequiredServiceBinding(inspect, binding)) }),
    });
  }
  if (JSON.stringify([...seenRoles].sort()) !== JSON.stringify(expectedRoles)) {
    throw new Error(
      "candidate runtime does not contain exactly the sealed image roles",
    );
  }
  const sortedServices = services.sort((left, right) =>
    left.role.localeCompare(right.role),
  );
  const configurations = effectiveRuntimeServiceConfigurations(inspections);
  const effectiveConfigSha256 = sha256Value(configurations);
  if (
    effectiveConfigSha256 !==
    identity.candidate.config.effective_runtime_services_sha256
  ) {
    throw new Error(
      "candidate runtime effective service configuration does not bind the sealed identity",
    );
  }
  return Object.freeze(
    sortedServices.map((service) => ({
      ...service,
      effective_configuration_sha256: configurations.find(
        (configuration) => configuration.role === service.role,
      ).effective_configuration_sha256,
    })),
  );
}

function normalizeRecordedServices(
  identity,
  recordedServices,
  requiredServiceBindings = [],
) {
  const requiredBindings = normalizeRequiredServiceBindings(
    requiredServiceBindings,
    identity,
  );
  if (!Array.isArray(recordedServices) || recordedServices.length === 0) {
    throw new Error("candidate runtime observation lacks services");
  }
  const expectedRoles = Object.keys(identity.candidate.images).sort();
  const services = [];
  for (const rawService of recordedServices) {
    const service = requirePlainObject(
      rawService,
      "candidate runtime observation service",
    );
    const role = requireNonEmptyString(
      service.role,
      "candidate runtime observation service role",
    );
    if (!Object.hasOwn(identity.candidate.images, role)) {
      throw new Error(
        "candidate runtime observation contains an unrecognized container role",
      );
    }
    if (services.some((candidate) => candidate.role === role)) {
      throw new Error(
        `candidate runtime observation has more than one container for role ${role}`,
      );
    }
    const inspection = {
      Id: service.container_id,
      Image: service.image_id,
      Config: { Labels: service.labels },
      State: {
        Running: service.state?.running,
        Status: service.state?.status,
        ...(service.state?.health === null ||
        service.state?.health === undefined
          ? {}
          : { Health: { Status: service.state.health } }),
      },
      ...(role === "caddy" ? {
        NetworkSettings: { Ports: { "443/tcp": [{ HostIp: service.https_binding?.host_address, HostPort: String(service.https_binding?.host_port) }] } },
      } : {}),
    };
    const labels = requireMatchingLabels(
      inspectLabels(inspection, role),
      identity,
      role,
    );
    const imageId = inspectImage(inspection, role);
    if (imageId !== identity.candidate.images[role]) {
      throw new Error(
        `candidate ${role} image does not bind the sealed candidate identity`,
      );
    }
    const roleBindings = bindingsForRole(requiredBindings, role);
    services.push({
      role,
      container_id: inspectContainerId(inspection, role),
      image_id: imageId,
      state: requireRunning(inspection, role),
      labels,
      effective_configuration_sha256: requireSha256(
        service.effective_configuration_sha256,
        `candidate ${role} effective configuration SHA-256`,
      ),
      ...(role === "caddy"
        ? { https_binding: exactLoopbackBinding(inspection, identity) }
        : {}),
      ...(roleBindings.length === 0 ? {} : { required_bindings: normalizeRecordedRequiredBindings(service, roleBindings) }),
    });
  }
  if (
    JSON.stringify(services.map((service) => service.role).sort()) !==
    JSON.stringify(expectedRoles)
  ) {
    throw new Error(
      "candidate runtime observation does not contain exactly the sealed image roles",
    );
  }
  const sortedServices = services.sort((left, right) =>
    left.role.localeCompare(right.role),
  );
  const effectiveConfigSha256 = sha256Value(
    sortedServices.map(({ role, effective_configuration_sha256 }) => ({
      role,
      effective_configuration_sha256,
    })),
  );
  if (
    effectiveConfigSha256 !==
    identity.candidate.config.effective_runtime_services_sha256
  ) {
    throw new Error(
      "candidate runtime observation effective configuration does not bind the sealed identity",
    );
  }
  return Object.freeze(sortedServices);
}

async function dockerListContainers(project) {
  const { stdout } = await execFileAsync(
    "docker",
    [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=${RUNTIME_LABELS.project}=${project}`,
    ],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function dockerInspectContainer(containerId) {
  const { stdout } = await execFileAsync("docker", ["inspect", containerId], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const value = JSON.parse(stdout);
  if (!Array.isArray(value) || value.length !== 1 || !isPlainObject(value[0])) {
    throw new Error(
      `docker inspect did not return exactly one candidate container for ${containerId}`,
    );
  }
  return value[0];
}

export function validateCandidateRuntimeObservation(
  value,
  identity,
  { identitySha256 = null, requiredServiceBindings = [] } = {},
) {
  const observation = requirePlainObject(
    value,
    "candidate runtime observation",
  );
  if (observation.schema !== STANDING_CANDIDATE_RUNTIME_OBSERVATION_SCHEMA) {
    throw new Error(
      `candidate runtime observation must use ${STANDING_CANDIDATE_RUNTIME_OBSERVATION_SCHEMA}`,
    );
  }
  if (observation.status !== "bound") {
    throw new Error("candidate runtime observation is not bound");
  }
  requireIsoTimestamp(
    observation.observed_at,
    "candidate runtime observation observed_at",
  );
  const candidate = requirePlainObject(
    observation.candidate,
    "candidate runtime observation candidate",
  );
  if (
    candidate.compose_project !== identity.candidate.compose_project ||
    candidate.wikijump_commit !== identity.candidate.wikijump_commit ||
    candidate.wikijump_tree !== identity.candidate.wikijump_tree ||
    candidate.ftml_sha !== identity.candidate.ftml_sha ||
    candidate.artifact_key !== identity.artifact_key ||
    candidate.profile !== identity.candidate.profile ||
    candidate.config_sha256 !==
      identity.candidate.config.isolated_overlay_sha256 ||
    candidate.effective_runtime_services_sha256 !==
      identity.candidate.config.effective_runtime_services_sha256
  ) {
    throw new Error(
      "candidate runtime observation does not bind the sealed candidate identity",
    );
  }
  const observedIdentitySha256 = requireSha256(
    observation.candidate_identity_sha256,
    "candidate runtime observation candidate identity SHA-256",
  );
  if (
    identitySha256 !== null &&
    observedIdentitySha256 !==
      requireSha256(identitySha256, "candidate identity SHA-256")
  ) {
    throw new Error(
      "candidate runtime observation does not bind the expected candidate identity file",
    );
  }
  requireGitObject(
    candidate.wikijump_commit,
    "candidate runtime observation Wikijump commit",
  );
  requireGitObject(
    candidate.wikijump_tree,
    "candidate runtime observation Wikijump tree",
  );
  requireGitObject(
    candidate.ftml_sha,
    "candidate runtime observation FTML SHA",
  );
  requireSha256(
    candidate.artifact_key,
    "candidate runtime observation artifact key",
  );
  requireSha256(
    candidate.config_sha256,
    "candidate runtime observation config SHA-256",
  );
  requireSha256(
    candidate.effective_runtime_services_sha256,
    "candidate runtime observation effective services SHA-256",
  );
  const services = normalizeRecordedServices(
    identity,
    observation.services,
    requiredServiceBindings,
  );
  return Object.freeze({
    schema: STANDING_CANDIDATE_RUNTIME_OBSERVATION_SCHEMA,
    status: "bound",
    observed_at: observation.observed_at,
    candidate_identity_sha256: observedIdentitySha256,
    candidate: {
      compose_project: identity.candidate.compose_project,
      wikijump_commit: identity.candidate.wikijump_commit,
      wikijump_tree: identity.candidate.wikijump_tree,
      ftml_sha: identity.candidate.ftml_sha,
      artifact_key: identity.artifact_key,
      profile: identity.candidate.profile,
      config_sha256: identity.candidate.config.isolated_overlay_sha256,
      effective_runtime_services_sha256:
        identity.candidate.config.effective_runtime_services_sha256,
    },
    services,
  });
}

export async function observeCandidateRuntimeIdentity({
  identity,
  identitySha256,
  requiredServiceBindings = [],
  listContainers = dockerListContainers,
  inspectContainer = dockerInspectContainer,
  now = () => new Date().toISOString(),
} = {}) {
  requirePlainObject(identity, "candidate identity");
  const candidateIdentitySha256 = requireSha256(
    identitySha256,
    "candidate identity SHA-256",
  );
  const containerIds = await listContainers(identity.candidate.compose_project);
  if (!Array.isArray(containerIds) || containerIds.length === 0) {
    throw new Error(
      "candidate runtime has no containers for the sealed compose project",
    );
  }
  const inspections = await Promise.all(
    containerIds.map((containerId) => inspectContainer(containerId)),
  );
  const observation = {
    schema: STANDING_CANDIDATE_RUNTIME_OBSERVATION_SCHEMA,
    status: "bound",
    observed_at: requireIsoTimestamp(
      now(),
      "candidate runtime observation current time",
    ),
    candidate_identity_sha256: candidateIdentitySha256,
    candidate: {
      compose_project: identity.candidate.compose_project,
      wikijump_commit: identity.candidate.wikijump_commit,
      wikijump_tree: identity.candidate.wikijump_tree,
      ftml_sha: identity.candidate.ftml_sha,
      artifact_key: identity.artifact_key,
      profile: identity.candidate.profile,
      config_sha256: identity.candidate.config.isolated_overlay_sha256,
      effective_runtime_services_sha256:
        identity.candidate.config.effective_runtime_services_sha256,
    },
    services: normalizedServices(identity, inspections, requiredServiceBindings),
  };
  return Object.freeze({
    ...observation,
    observation_sha256: sha256Value(observation),
  });
}

export function assertStableCandidateRuntimeIdentity(
  before,
  after,
  identity,
  { identitySha256 = null, requiredServiceBindings = [] } = {},
) {
  const stableBefore = validateCandidateRuntimeObservation(before, identity, {
    identitySha256,
    requiredServiceBindings,
  });
  const stableAfter = validateCandidateRuntimeObservation(after, identity, {
    identitySha256,
    requiredServiceBindings,
  });
  const comparable = (observation) => ({
    ...observation,
    observed_at: null,
  });
  if (
    sha256Value(comparable(stableBefore)) !==
    sha256Value(comparable(stableAfter))
  ) {
    throw new Error(
      "candidate runtime identity changed during browser parity capture",
    );
  }
  return stableAfter;
}
