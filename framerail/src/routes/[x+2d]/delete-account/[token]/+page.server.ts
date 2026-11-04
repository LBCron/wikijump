import {
  deleteCompleteAction,
  deleteRedeemAction,
  loadDeleteTokenPage
} from "$lib/server/load/email-token"

export async function load({ request, parent, params }) {
  return loadDeleteTokenPage(request, parent, params.token)
}

export const actions = { redeem: deleteRedeemAction, confirm: deleteCompleteAction }
