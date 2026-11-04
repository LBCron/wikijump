import { parseDeploymentEnvironment } from "./deployment-environment.ts"

const DEFAULT_PLATFORM_DOMAINS = {
  local: { main: "wikijump.localhost", files: "wjfiles.localhost" },
  dev: { main: "wikijump.dev", files: "wjfiles.dev" },
  prod: { main: "wikijump.com", files: "wjfiles.com" }
}

const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u

const configuredHostname = (
  value: string | undefined,
  name: string,
  fallback: string
): string => {
  if (value === undefined || value === "") return fallback
  if (!HOSTNAME.test(value)) {
    throw new Error(
      `${name} must be a bare lowercase hostname (set the port with WIKIJUMP_HTTPS_PORT): ${JSON.stringify(value)}`
    )
  }
  return value
}

const configuredHttpsPort = (value: string | undefined): number => {
  if (value === undefined || value === "") return 443
  const port = Number(value)
  if (!/^[0-9]+$/u.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`WIKIJUMP_HTTPS_PORT must be a TCP port: ${JSON.stringify(value)}`)
  }
  return port
}

export const LOCAL_MIRROR_FILE_ASSET_SITES = ["scp-wiki", "scp-jp"]

export const platformDomains = ({
  deploymentEnvironment = parseDeploymentEnvironment(),
  env = process.env
}: {
  deploymentEnvironment?: "local" | "dev" | "prod"
  env?: Record<string, string | undefined>
} = {}): { main: string; files: string; httpsPort: number } => {
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

export const platformHttpsOrigin = (
  host: string,
  { httpsPort }: { httpsPort: number }
): string => (httpsPort === 443 ? `https://${host}` : `https://${host}:${httpsPort}`)
