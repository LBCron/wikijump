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

/**
 * Map a SvelteKit enhanced-form result from the native `/-/login` action
 * to the dialog outcome. The MFA session token is intentionally ignored
 * here: the in-place surface does not hold it, so MFA continues on the
 * native page.
 */
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

/**
 * Only a plain primary-button activation opens the in-place surface.
 * Modified clicks, middle clicks, and other non-primary activations keep
 * the native link behaviour.
 */
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

/**
 * Wikidot permission-denial copy offers sign-in through this legacy action
 * href (for example the NewPage "Sign in as Wikidot user" link and the
 * file-attach denial action link). The href stays verbatim so the observed
 * Wikidot markup is preserved; the delegated installer below gives it the
 * in-place surface on pages where that surface exists.
 */
export const WIKIDOT_LOGIN_ACTION_HREF = "#action:login"

const WIKIDOT_LOGIN_ACTION_ANCHOR = `a[href="${WIKIDOT_LOGIN_ACTION_HREF}"]`

/**
 * Route legacy `#action:login` activations to the same in-place sign-in
 * surface that owns the login-status Sign in control. Only plain primary
 * activations are intercepted, and only while the surface is available
 * (imported Wikidot layout, anonymous viewer). Everywhere else the click
 * keeps its existing behaviour, so native layouts and modified clicks are
 * unchanged.
 */
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
