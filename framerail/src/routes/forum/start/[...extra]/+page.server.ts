import { wikidotForumModule } from "$lib/server/deepwell/forum"
import { loadForumStartRoute } from "$lib/server/forum-routes"
import { loadSiteInfo } from "$lib/server/load/site-info"

import type { PageServerLoad } from "./$types"

export const load: PageServerLoad = (event) =>
  loadForumStartRoute(event, { loadSiteInfo, wikidotForumModule })
