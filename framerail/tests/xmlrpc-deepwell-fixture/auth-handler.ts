import type { IncomingMessage } from "node:http"

import { handleIdentityRpc } from "./identity-handler.ts"
import { handlePageLabelTranslationRpc } from "./page-label-translation-handler.ts"
import { handleSiteRpc } from "./site-handler.ts"

export const handleAuthRpc = (input: { rpcRequest: any; request: IncomingMessage }) => {
  return (
    handleIdentityRpc(input) ??
    handlePageLabelTranslationRpc(input) ??
    handleSiteRpc(input)
  )
}
