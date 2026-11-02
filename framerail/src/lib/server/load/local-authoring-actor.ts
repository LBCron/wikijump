import { parseDeploymentEnvironment } from "../deployment-environment.js"

const LOCAL_ADMIN_USER_ID = -1
const EDITABLE_LOCAL_SITE_SLUG = "scpaiueouiuiuiui"

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

  if (
    deploymentEnvironment === "local" &&
    siteSlug === EDITABLE_LOCAL_SITE_SLUG &&
    mutationSiteId === requestSiteId
  ) {
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
