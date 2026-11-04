const DEPLOYMENT_ENVIRONMENTS = new Set(["local", "dev", "prod"])

export const parseDeploymentEnvironment = ({
  framerailEnv = process.env.FRAMERAIL_ENV,
  nodeEnv = process.env.NODE_ENV
}: { framerailEnv?: string | null; nodeEnv?: string | null } = {}):
  "local" | "dev" | "prod" => {
  if (framerailEnv === undefined || framerailEnv === null || framerailEnv === "") {
    return nodeEnv === "development" ? "local" : "prod"
  }
  if (!DEPLOYMENT_ENVIRONMENTS.has(framerailEnv)) {
    throw new Error(`Invalid FRAMERAIL_ENV: ${JSON.stringify(framerailEnv)}`)
  }
  return framerailEnv as "local" | "dev" | "prod"
}

export const parseCsrfCheckOrigin = ({
  csrfCheckOrigin = process.env.FRAMERAIL_CSRF_CHECK_ORIGIN,
  deploymentEnvironment = parseDeploymentEnvironment()
}: {
  csrfCheckOrigin?: string | null
  deploymentEnvironment?: "local" | "dev" | "prod"
} = {}): boolean => {
  if (
    csrfCheckOrigin === undefined ||
    csrfCheckOrigin === null ||
    csrfCheckOrigin === ""
  ) {
    return deploymentEnvironment !== "local"
  }
  if (csrfCheckOrigin === "true") return true
  if (csrfCheckOrigin === "false") return false
  throw new Error(
    `Invalid FRAMERAIL_CSRF_CHECK_ORIGIN: ${JSON.stringify(csrfCheckOrigin)}`
  )
}

/**
 * Maps the legacy deployment/env switch onto SvelteKit's current CSRF API.
 * An empty trusted-origin list preserves same-origin checking; "*" is the
 * documented replacement for the former checkOrigin=false behavior.
 */
export const csrfTrustedOrigins = (
  input?: Parameters<typeof parseCsrfCheckOrigin>[0]
): string[] => (parseCsrfCheckOrigin(input) ? [] : ["*"])
