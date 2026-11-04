import { wikidotForumModule } from "$lib/server/deepwell/forum"
import { loadForumCategoryRoute } from "$lib/server/forum-routes"
import { loadSiteInfo } from "$lib/server/load/site-info"

import type { PageServerLoad } from "./$types"

export const load: PageServerLoad = (event) =>
  loadForumCategoryRoute(event, { loadSiteInfo, wikidotForumModule })
