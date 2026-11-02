import { Buffer } from "node:buffer"

import { wikidotFeedIconPng } from "$lib/server/wikidot-feed-icon"

import type { RequestHandler } from "./$types"

export const GET: RequestHandler = () =>
  new Response(Buffer.from(wikidotFeedIconPng()), {
    headers: {
      "cache-control": "public, max-age=86400",
      "content-type": "image/png"
    }
  })
