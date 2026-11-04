export const WIKIDOT_LOGIN_DIALOG_LABELS = Object.freeze({
  title: "Sign in",
  specifier: "Email or Username",
  password: "Password",
  submit: "Login",
  cancel: "Cancel",
  failed: "Sign in failed. Check your details and try again.",
  mfaRequired:
    "Two-step verification is required. Continue on the sign-in page to enter your code.",
  signInPage: "Open the sign-in page",
  unavailable: "Sign in is unavailable right now. Try again later."
})

export const interpretLoginActionResult = (
  result: { type?: string; data?: unknown } | null | undefined
):
  | { kind: "success" }
  | { kind: "mfa" }
  | { kind: "failure"; message: string | null }
  | { kind: "error" } => {
  if (result?.type === "success") {
    const data = (result.data ?? {}) as {
      needsMfa?: unknown
      isLoggedIn?: unknown
    }
    if (data.needsMfa === true) return { kind: "mfa" }
    if (data.isLoggedIn === true) return { kind: "success" }
    return { kind: "failure", message: null }
  }

  if (result?.type === "failure") {
    const data = (result.data ?? {}) as { message?: unknown }
    return {
      kind: "failure",
      message: typeof data.message === "string" ? data.message : null
    }
  }

  return { kind: "error" }
}

export const isPlainPrimaryActivation = (event: {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey

export const WIKIDOT_LOGIN_ACTION_HREF = "#action:login"

const WIKIDOT_LOGIN_ACTION_ANCHOR = `a[href="${WIKIDOT_LOGIN_ACTION_HREF}"]`

export const installWikidotLoginActionHandler = (
  root: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  hooks: {
    isSurfaceAvailable: () => boolean
    openSurface: () => void
  }
): (() => void) => {
  const handler = (event: Event) => {
    if (event.defaultPrevented) return
    const target = event.target as Element | null
    if (typeof target?.closest !== "function" || target === null) return
    if (!target.closest(WIKIDOT_LOGIN_ACTION_ANCHOR)) return
    if (!isPlainPrimaryActivation(event as MouseEvent)) return
    if (!hooks.isSurfaceAvailable()) return
    event.preventDefault()
    hooks.openSurface()
  }

  root.addEventListener("click", handler)
  return () => root.removeEventListener("click", handler)
}
