import { parseDeploymentEnvironment } from "./deployment-environment.js"

const DEFAULT_PLATFORM_DOMAINS = {
  local: { main: "wikijump.localhost", files: "wjfiles.localhost" },
  dev: { main: "wikijump.dev", files: "wjfiles.dev" },
  prod: { main: "wikijump.com", files: "wjfiles.com" }
}

const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u

/**
 * @param {string | undefined} value
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
const configuredHostname = (value, name, fallback) => {
  if (value === undefined || value === "") return fallback
  if (!HOSTNAME.test(value)) {
    throw new Error(
      `${name} must be a bare lowercase hostname (set the port with WIKIJUMP_HTTPS_PORT): ${JSON.stringify(value)}`
    )
  }
  return value
}

/**
 * @param {string | undefined} value
 * @returns {number}
 */
const configuredHttpsPort = (value) => {
  if (value === undefined || value === "") return 443
  const port = Number(value)
  if (!/^[0-9]+$/u.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`WIKIJUMP_HTTPS_PORT must be a TCP port: ${JSON.stringify(value)}`)
  }
  return port
}

/**
 * @param {{
 *   deploymentEnvironment?: "local" | "dev" | "prod"
 *   env?: Record<string, string | undefined>
 * }} [input]
 * @returns {{ main: string; files: string; httpsPort: number }}
 * @throws {Error} If an override is not a bare hostname or a TCP port.
 */
export const LOCAL_MIRROR_FILE_ASSET_SITES = ["scp-wiki", "scp-jp"]

export const platformDomains = ({
  deploymentEnvironment = parseDeploymentEnvironment(),
  env = process.env
} = {}) => {
  const defaults = DEFAULT_PLATFORM_DOMAINS[deploymentEnvironment]
  return {
    main: configuredHostname(
      env.WIKIJUMP_MAIN_DOMAIN,
      "WIKIJUMP_MAIN_DOMAIN",
      defaults.main
    ),
    files: configuredHostname(
      env.WIKIJUMP_FILES_DOMAIN,
      "WIKIJUMP_FILES_DOMAIN",
      defaults.files
    ),
    httpsPort: configuredHttpsPort(env.WIKIJUMP_HTTPS_PORT)
  }
}

/**
 * The absolute HTTPS origin of one of the platform's hosts.
 *
 * @param {string} host
 * @param {{ httpsPort: number }} domains
 * @returns {string}
 */
export const platformHttpsOrigin = (host, { httpsPort }) =>
  httpsPort === 443 ? `https://${host}` : `https://${host}:${httpsPort}`
