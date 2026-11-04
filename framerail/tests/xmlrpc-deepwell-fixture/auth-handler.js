import { handleIdentityRpc } from "./identity-handler.js"
import { handlePageLabelTranslationRpc } from "./page-label-translation-handler.ts"
import { handleSiteRpc } from "./site-handler.js"

/**
 * @param {{
 *   rpcRequest: any
 *   request: import("node:http").IncomingMessage
 * }} input
 */
export const handleAuthRpc = (input) => {
  return (
    handleIdentityRpc(input) ??
    handlePageLabelTranslationRpc(input) ??
    handleSiteRpc(input)
  )
}
