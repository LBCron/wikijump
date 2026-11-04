export type UserInfoTab = { id: string; label: string }

export type UserInfoTabState = { selected: string; deselected: string[] }

export const USER_INFO_TABS: readonly UserInfoTab[] = Object.freeze([
  Object.freeze({ id: "ui-profile-b", label: "Profile" }),
  Object.freeze({ id: "ui-member-b", label: "Member of" }),
  Object.freeze({ id: "ui-moderator-b", label: "Moderator of" }),
  Object.freeze({ id: "ui-admin-b", label: "Admin of" }),
  Object.freeze({ id: "ui-contrib-b", label: "Recent contributions" }),
  Object.freeze({ id: "ui-posts-b", label: "Recent posts and comments" })
])

const DEFAULT_TAB_ID = "ui-profile-b"

export const initialUserInfoTabState = (): UserInfoTabState => ({
  selected: DEFAULT_TAB_ID,
  deselected: []
})

export const selectUserInfoTab = (
  state: UserInfoTabState,
  id: string
): UserInfoTabState => {
  if (!USER_INFO_TABS.some((tab) => tab.id === id)) {
    throw new Error(`Unknown user:info tab: ${id}`)
  }
  if (state.selected === id) return state
  return {
    selected: id,
    deselected: state.deselected.includes(state.selected)
      ? state.deselected
      : [...state.deselected, state.selected]
  }
}

export const userInfoTabClass = (
  state: UserInfoTabState,
  id: string
): "active" | "" | undefined => {
  if (state.selected === id) return "active"
  return state.deselected.includes(id) ? "" : undefined
}
