import {
  loadResetTokenPage,
  resetCompleteAction,
  resetRedeemAction
} from "$lib/server/load/email-token"

export async function load({ request, parent, params }) {
  return loadResetTokenPage(request, parent, params.token)
}

export const actions = { redeem: resetRedeemAction, setPassword: resetCompleteAction }
