export interface ArticleRouteEntry {
  id: string
  preload: boolean
  anonymousCache: boolean
}

export const ARTICLE_ROUTE_REGISTRY: readonly ArticleRouteEntry[] = [
  { id: "/", preload: true, anonymousCache: true },
  { id: "/[slug]/[...extra]", preload: true, anonymousCache: true },
  { id: "/[x+2d]/user/[slug]", preload: true, anonymousCache: false }
]

export const PAGE_ROUTES_WITH_ARTICLE_PRELOAD = new Set(
  ARTICLE_ROUTE_REGISTRY.filter((entry) => entry.preload).map((entry) => entry.id)
)

export const ARTICLE_ROUTES = new Set(
  ARTICLE_ROUTE_REGISTRY.filter((entry) => entry.anonymousCache).map((entry) => entry.id)
)
