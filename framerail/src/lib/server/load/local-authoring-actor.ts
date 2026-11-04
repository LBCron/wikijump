import { parseDeploymentEnvironment } from "../deployment-environment.ts"

const LOCAL_ADMIN_USER_ID = -1
const EDITABLE_LOCAL_SITE_SLUG = "scpaiueouiuiuiui"

type EditableLocalSiteBinding = {
  siteSlug: typeof EDITABLE_LOCAL_SITE_SLUG
  requestSiteId: number
}

function bindEditableLocalSite(
  deploymentEnvironment: ReturnType<typeof parseDeploymentEnvironment>,
  siteSlug: string,
  requestSiteId: number
): EditableLocalSiteBinding | undefined {
  if (deploymentEnvironment !== "local") return undefined
  if (siteSlug !== EDITABLE_LOCAL_SITE_SLUG) return undefined
  return { siteSlug: EDITABLE_LOCAL_SITE_SLUG, requestSiteId }
}

export function resolvePageMutationUserId(
  sessionUserId: number | undefined,
  siteSlug: string,
  requestSiteId: number,
  mutationSiteId: number,
  deploymentEnvironment = parseDeploymentEnvironment()
): number | undefined {
  if (sessionUserId !== undefined) {
    return sessionUserId
  }

  const binding = bindEditableLocalSite(deploymentEnvironment, siteSlug, requestSiteId)
  if (binding?.requestSiteId === mutationSiteId) {
    return LOCAL_ADMIN_USER_ID
  }

  return undefined
}

export function resolveLocalAuthoringMutationMarker(
  sessionUserId: number | undefined,
  siteSlug: string,
  requestSiteId: number,
  mutationSiteId: number,
  deploymentEnvironment = parseDeploymentEnvironment()
): boolean {
  return (
    sessionUserId === undefined &&
    resolvePageMutationUserId(
      sessionUserId,
      siteSlug,
      requestSiteId,
      mutationSiteId,
      deploymentEnvironment
    ) === LOCAL_ADMIN_USER_ID
  )
}
