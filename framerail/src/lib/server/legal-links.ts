import { parseDeploymentEnvironment } from "./deployment-environment.ts"
import { platformDomains, platformHttpsOrigin } from "./platform-domains.ts"

const PLATFORM_LEGAL_PATHS = {
  termsOfService: "/legal:terms-of-service",
  privacyPolicy: "/legal:privacy-policy"
}

const PLATFORM_FOOTER_PATHS = {
  docs: "/docs",
  security: "/legal:security"
}

const LEGAL_DESTINATION_ENVIRONMENT_VARIABLES = {
  termsOfService: "WIKIJUMP_TERMS_OF_SERVICE_URL",
  privacyPolicy: "WIKIJUMP_PRIVACY_POLICY_URL"
}

export type LegalDestinationKey = keyof typeof PLATFORM_LEGAL_PATHS
export type LegalDestinations = Record<LegalDestinationKey, string>

const configuredDestination = (
  value: string | undefined,
  environmentVariable: string
): string | null => {
  if (value === undefined || value === null || value.trim() === "") return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(`Invalid ${environmentVariable}: not an absolute URL`)
  }
  if (url.protocol !== "https:") {
    throw new Error(`Invalid ${environmentVariable}: must be an https URL`)
  }
  return url.toString()
}

export const legalDestinations = ({
  deploymentEnvironment = parseDeploymentEnvironment(),
  env = process.env
}: {
  deploymentEnvironment?: "local" | "dev" | "prod"
  env?: Record<string, string | undefined>
} = {}): LegalDestinations => {
  const domains = platformDomains({ deploymentEnvironment, env })
  const origin = platformHttpsOrigin(domains.main, domains)
  const keys = Object.keys(PLATFORM_LEGAL_PATHS) as LegalDestinationKey[]

  return keys.reduce<LegalDestinations>((destinations, key) => {
    const environmentVariable = LEGAL_DESTINATION_ENVIRONMENT_VARIABLES[key]
    const configured = configuredDestination(
      env[environmentVariable],
      environmentVariable
    )
    destinations[key] = configured ?? `${origin}${PLATFORM_LEGAL_PATHS[key]}`
    return destinations
  }, {} as LegalDestinations)
}

export const platformFooterDestinations = ({
  deploymentEnvironment = parseDeploymentEnvironment(),
  env = process.env
}: {
  deploymentEnvironment?: "local" | "dev" | "prod"
  env?: Record<string, string | undefined>
} = {}): Record<string, string> => {
  const domains = platformDomains({ deploymentEnvironment, env })
  const origin = platformHttpsOrigin(domains.main, domains)
  const legal = legalDestinations({ deploymentEnvironment, env })
  return {
    "terms-conditions": legal.termsOfService,
    privacy: legal.privacyPolicy,
    docs: `${origin}${PLATFORM_FOOTER_PATHS.docs}`,
    security: `${origin}${PLATFORM_FOOTER_PATHS.security}`
  }
}
