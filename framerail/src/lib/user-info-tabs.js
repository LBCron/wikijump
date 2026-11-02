
/**
 * @typedef {{ id: string; label: string }} UserInfoTab
 *
 * @typedef {{ selected: string; deselected: string[] }} UserInfoTabState
 */

/** @type {readonly UserInfoTab[]} */
export const USER_INFO_TABS = Object.freeze([
  Object.freeze({ id: "ui-profile-b", label: "Profile" }),
  Object.freeze({ id: "ui-member-b", label: "Member of" }),
  Object.freeze({ id: "ui-moderator-b", label: "Moderator of" }),
  Object.freeze({ id: "ui-admin-b", label: "Admin of" }),
  Object.freeze({ id: "ui-contrib-b", label: "Recent contributions" }),
  Object.freeze({ id: "ui-posts-b", label: "Recent posts and comments" })
])

const DEFAULT_TAB_ID = "ui-profile-b"

/** @returns {UserInfoTabState} */
export const initialUserInfoTabState = () => ({
  selected: DEFAULT_TAB_ID,
  deselected: []
})

/**
 * @param {UserInfoTabState} state
 * @param {string} id
 * @returns {UserInfoTabState}
 */
export const selectUserInfoTab = (state, id) => {
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

/**
 * The class attribute of a tab item: `active` while selected, an empty
 * class once the item has lost a selection, and no attribute before its
 * first change.
 *
 * @param {UserInfoTabState} state
 * @param {string} id
 * @returns {"active" | "" | undefined}
 */
export const userInfoTabClass = (state, id) => {
  if (state.selected === id) return "active"
  return state.deselected.includes(id) ? "" : undefined
}
