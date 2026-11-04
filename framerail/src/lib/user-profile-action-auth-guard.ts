export const showUserProfileActionAuthenticationGuard = (popupState: {
  current: {
    state: boolean
    title?: string | null
    message: string | null
    data: unknown | null
  }
}): void => {
  popupState.current = {
    state: true,
    title: "Permission error",
    message: "Please note:",
    data: "Please create a Wikidot account and/or sign in first"
  }
}
