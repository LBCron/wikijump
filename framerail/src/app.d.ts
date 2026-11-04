import type { PageModel, PageOptions, PageRevisionModel } from "$lib/types"
import type { PreloadData } from "$lib/server/deepwell/views"
import type { RequestContext } from "$lib/server/request-context"
import type { buildWikidotRequestInfo } from "$lib/server/wikidot-request-info"
import type { Locales } from "./types"

declare global {
  declare namespace App {
    interface PageData extends PreloadData {
      page?: PageModel
      options?: PageOptions
      wikitext?: string
      internationalization?: Partial<Locales>
      compiled_body_html?: string
      compiled_body_styles?: string[]
      compiled_top_bar_html?: string | null
      compiled_side_bar_html?: string | null
      page_revision?: PageRevisionModel
    }

    interface Error extends PageData {
      message?: string
      view: string
      internationalization?: Partial<Locales>
      compiled_body_html?: string
    }
    interface Locals {
      requestContext: RequestContext
      siteLocale?: string
      wikidotDocument?: boolean
      wikidotRequestInfo?: ReturnType<typeof buildWikidotRequestInfo>
      anonymousArticleResponseCacheMetadata?: {
        siteId: number
        siteSlug: string
        requestHost: string
        requestLocales: string[]
        backendLocales: string[]
        deepwellArticlePageCacheKey: string
        publicContentFence: string
        permissionFence: string
      }
    }
  }
}
