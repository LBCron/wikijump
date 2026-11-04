import type { UserViewResult, UserViewUser } from "./deepwell/user"
import type { UserType } from "$lib/types"

export const WIKIDOT_USER_INFO_MISSING = "User does not exist."

export type UserView = (
  siteId: number,
  locales: string[],
  sessionToken: undefined,
  target: string
) => Promise<UserViewResult>

export type LoadAvatar = (hash: number[]) => Promise<string>

export interface PublicUser {
  userId: number
  name: string
  slug: string
  accountType?: UserType | "free"
  karmaLevel?: "none" | "high"
  createdAt: string
  avatar?: string
}

export interface PrivateMessageControl {
  label: string
  authenticationPath: string
}

export interface ProfileActionControl {
  label: string
}

export interface UserInfoFound {
  status: 200
  view: "user_found"
  user: PublicUser
  privateMessageControl: PrivateMessageControl
  contactControl: ProfileActionControl
  abuseReportControl: ProfileActionControl
}

export interface UserInfoMissing {
  status: 200
  view: "user_missing"
  error: string
}

/**
 * The live public profile action row. Anonymous viewers reach the Wikidot
 * authentication boundary: the private-message action navigates to the
 * sign-in surface (live Wikidot links to `/account/messages#/new/<id>`,
 * which asks an anonymous visitor to sign in), while `Add to contacts` and
 * `flag user as abusive` open the same-page permission error recorded in
 * `user-profile-action-auth-guard.js`.
 *
 * The authenticated compose/contact/report lifecycles are not implemented,
 * so the controls are only rendered for viewers without a session instead
 * of being exposed as dead controls. No Wikidot numeric user ID is encoded
 * into a local URL: the recipient or report subject is addressed by the
 * stable projected user ID carried on the rendered controls.
 */
const PRIVATE_MESSAGE_CONTROL: PrivateMessageControl = Object.freeze({
  label: "Write private message",
  authenticationPath: "/-/login"
})

const CONTACT_CONTROL: ProfileActionControl = Object.freeze({
  label: "Add to contacts"
})

const ABUSE_REPORT_CONTROL: ProfileActionControl = Object.freeze({
  label: "flag user as abusive"
})

const projectPublicUser = async (
  user: UserViewUser,
  loadAvatar: LoadAvatar | undefined
): Promise<PublicUser> => {
  if (user.name === null || user.slug === null) {
    throw new Error("Found user view response has no public identity")
  }

  const avatar =
    user.avatar_s3_hash !== null && loadAvatar
      ? await loadAvatar(user.avatar_s3_hash)
      : undefined

  const imported = user.user_type === "wikidot"
  const karmaLevel = imported
    ? user.karma === 0
      ? "none"
      : user.karma === 3
        ? "high"
        : undefined
    : undefined

  return {
    userId: user.user_id,
    name: user.name,
    slug: user.slug,
    ...(imported
      ? user.is_pro
        ? {}
        : { accountType: "free" }
      : { accountType: user.user_type }),
    ...(karmaLevel === undefined ? {} : { karmaLevel }),
    createdAt: user.created_at,
    ...(avatar === undefined ? {} : { avatar })
  }
}

export const loadWikidotUserInfo = async ({
  siteId,
  locales,
  target,
  userView,
  loadAvatar
}: {
  siteId: number
  locales: string[]
  target: string
  userView: UserView
  loadAvatar?: LoadAvatar
}): Promise<UserInfoFound | UserInfoMissing> => {
  const response = await userView(siteId, locales, undefined, target)
  const responseType = response.type

  if (responseType === "user_missing") {
    return {
      status: 200,
      view: "user_missing",
      error: WIKIDOT_USER_INFO_MISSING
    }
  }

  if (responseType !== "user_found") {
    throw new Error(`Unexpected user view response '${responseType}'`)
  }

  return {
    status: 200,
    view: "user_found",
    user: await projectPublicUser(response.data.user, loadAvatar),
    privateMessageControl: PRIVATE_MESSAGE_CONTROL,
    contactControl: CONTACT_CONTROL,
    abuseReportControl: ABUSE_REPORT_CONTROL
  }
}
