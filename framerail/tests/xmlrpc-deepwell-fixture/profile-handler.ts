import type { IncomingMessage, ServerResponse } from "node:http"

import { fixtureState } from "./context.ts"
import { sendRpcError } from "./response.ts"

const AVATAR_OWNER_SESSION_TOKEN = "fixture-authenticated-session-token"

const AVATAR_HASH_HEX = "ab".repeat(64)
const AVATAR_HASH_BYTES = Array.from(Buffer.from(AVATAR_HASH_HEX, "hex"))

const MISSING_PROFILE_FIXTURE = "missing-profile-action-probe"

const AVATAR_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
)

export const handleProfileRpc = ({
  rpcRequest,
  request,
  response
}: {
  rpcRequest: any
  request: IncomingMessage
  response: ServerResponse
}) => {
  if (rpcRequest.method === "blob_get") {
    if (rpcRequest.params !== AVATAR_HASH_HEX) return undefined
    return {
      result: {
        data: Array.from(AVATAR_PNG),
        mime: "image/png",
        size: AVATAR_PNG.length,
        created_at: "2026-01-01T00:00:00Z"
      }
    }
  }

  if (rpcRequest.method === "user_edit") {
    const params = rpcRequest.params ?? {}
    if (
      params.user !== fixtureState.authenticatedUser.user_id ||
      request.headers["x-deepwell-session-token"] !==
        "fixture-authenticated-session-token"
    ) {
      return undefined
    }
    fixtureState.pageWriteRequests.userEdit.push({
      paramKeys: Object.keys(params).sort()
    })
    if (params.email === "not-a-valid-email") {
      sendRpcError(response, rpcRequest.id, -32000, "The user's email is invalid")
      return { responded: true }
    }
    for (const key of [
      "name",
      "email",
      "locales",
      "real_name",
      "gender",
      "birthday",
      "location",
      "biography",
      "website",
      "user_page"
    ] as const) {
      if (Object.hasOwn(params, key))
        (fixtureState.authenticatedUser as Record<string, any>)[key] = params[key]
    }
    return { result: fixtureState.authenticatedUser }
  }

  if (rpcRequest.method === "user_password_change") {
    const params = rpcRequest.params ?? {}
    if (
      request.headers["x-deepwell-session-token"] !==
      "fixture-authenticated-session-token"
    ) {
      return undefined
    }
    if (params.current_password !== "fixture-member-password") {
      sendRpcError(
        response,
        rpcRequest.id,
        4000,
        "Invalid username, password, or TOTP code"
      )
      return { responded: true }
    }
    return { result: { other_sessions_revoked: 2 } }
  }

  if (rpcRequest.method !== "user_view") return undefined

  const params = rpcRequest.params ?? {}
  if (params.site_id !== 6000005 || !Array.isArray(params.locales)) {
    return undefined
  }

  if (params.session_token === AVATAR_OWNER_SESSION_TOKEN && params.user === undefined) {
    return {
      result: {
        type: "user_found",
        data: {
          user: {
            ...fixtureState.authenticatedUser,
            name: PROFILE_FIXTURES["avatar-probe"].name,
            avatar_s3_hash: AVATAR_HASH_BYTES
          }
        }
      }
    }
  }

  if (params.session_token !== undefined) return undefined

  if (params.user === MISSING_PROFILE_FIXTURE) {
    return { result: { type: "user_missing" } }
  }

  const profile = Object.hasOwn(PROFILE_FIXTURES, params.user)
    ? PROFILE_FIXTURES[params.user]
    : undefined
  if (!profile) return undefined

  return userFound({ ...profile, slug: params.user })
}

const userFound = (profile: {
  user_id: number
  name: string
  website: string | null
  slug: string
  avatar?: boolean
  email?: string
  birthday?: string | null
  biography?: string | null
}) => ({
  result: {
    type: "user_found",
    data: {
      user: {
        user_id: profile.user_id,
        user_type: "regular",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: null,
        deleted_at: null,
        from_wikidot: false,
        name: profile.name,
        slug: profile.slug,
        name_changes_left: 0,
        last_name_change_added_at: "2026-01-01T00:00:00Z",
        last_renamed_at: null,
        email: profile.email ?? "",
        email_verified_at: null,
        email_validation_info: null,
        email_validation_at: null,
        password: "",
        multi_factor_secret: null,
        multi_factor_recovery_codes: null,
        locales: ["en"],
        avatar_s3_hash: profile.avatar ? AVATAR_HASH_BYTES : null,
        forum_signature: null,
        real_name: null,
        gender: null,
        birthday: profile.birthday ?? null,
        location: null,
        biography: profile.biography ?? null,
        website: profile.website,
        user_page: null
      }
    }
  }
})

const PROFILE_FIXTURES: Record<
  string,
  {
    user_id: number
    name: string
    website: string | null
    avatar?: boolean
    email?: string
    birthday?: string | null
    biography?: string | null
  }
> = {
  guest: {
    user_id: 987654,
    name: "Guest",
    website: null,
    email: "private-email-marker-2139@example.test",
    birthday: "private-birthday-marker-2139",
    biography: "private-biography-marker-2139"
  },
  "website-frozen-probe": {
    user_id: 987657,
    name: "Website Frozen Probe",
    website: "scp-wiki.wikidot.com/seekgull"
  },
  "website-probe": { user_id: 987655, name: "Website Probe", website: "example.org" },
  "website-unsafe-probe": {
    user_id: 987656,
    name: "Website Unsafe Probe",
    website: ["javascript", "alert(1)"].join(":")
  },
  "profile-action-probe": {
    user_id: 987658,
    name: "Profile Action Probe",
    website: null
  },
  "avatar-probe": {
    user_id: 6000008,
    name: "Avatar Probe",
    website: null,
    avatar: true
  }
}
