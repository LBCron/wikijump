export type MembershipBrowserAction = {
  type: "join" | "application" | "password" | "invitation"
  page_id: number
  revision_id: number
  index: number
  fingerprint: string
}

export type MembershipActionRuntime = {
  join?: (
    pageId: number,
    revisionId: number,
    index: number,
    fingerprint: string
  ) => unknown
  application?: (
    pageId: number,
    revisionId: number,
    index: number,
    fingerprint: string,
    comment: string
  ) => unknown
  password?: (
    pageId: number,
    revisionId: number,
    index: number,
    fingerprint: string,
    password: string
  ) => unknown
  invitation?: (
    pageId: number,
    revisionId: number,
    index: number,
    fingerprint: string
  ) => unknown
  reload?: (result: unknown) => unknown
  error?: (error: unknown) => unknown
}

type MembershipActionHandler = (
  pageId: number,
  revisionId: number,
  index: number,
  fingerprint: string,
  extra?: string
) => unknown

const JOIN_SELECTOR = `div > a[href="javascript:;"][onclick="WIKIDOT.page.listeners.join(event, 'unified')"]`
const APPLICATION_SELECTOR = `#membership-by-apply-form #mba-apply`
const PASSWORD_SELECTOR = `#membership-by-password-form #mbp-apply`
const INVITATION_SELECTOR = `#membership-email-invitation-box a[href="javascript:;"][onclick^="WIKIDOT.modules.MembershipEmailInvitationModule.listeners.accept"]`

const boundActions: WeakMap<HTMLElement, MembershipBrowserAction> = new WeakMap()
const busyActions: WeakSet<HTMLElement> = new WeakSet()

const validMembershipAction = (action: MembershipBrowserAction): boolean =>
  !!action &&
  ["join", "application", "password", "invitation"].includes(action.type) &&
  Number.isSafeInteger(action.page_id) &&
  action.page_id > 0 &&
  Number.isSafeInteger(action.revision_id) &&
  action.revision_id > 0 &&
  Number.isSafeInteger(action.index) &&
  action.index >= 0 &&
  /^[0-9a-f]{32}$/u.test(action.fingerprint)

const selectorForAction = (type: string): string | undefined => {
  if (type === "join") return JOIN_SELECTOR
  if (type === "application") return APPLICATION_SELECTOR
  if (type === "password") return PASSWORD_SELECTOR
  if (type === "invitation") return INVITATION_SELECTOR
  return undefined
}

const escapeHtml = (value: unknown): string =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

export const membershipEmailInvitationCongratulationsHtml = (
  siteName: unknown,
  siteSlug: unknown
): string => {
  const name = escapeHtml(siteName)
  const domain = escapeHtml(`${siteSlug}.wikidot.com`)
  return [
    "<h1>Congratulations!</h1>",
    `<p>You now a member of the site "${name}". Please click on the link below to go to this Site.</p>`,
    `<p style="text-align: center; font-weigh: bold; font-size: 140%;"><a href="http://${domain}">${domain}</a></p>`
  ].join("")
}

/**
 * Zip exact renderer-owned Join controls to the closed sidecar. Any count,
 * descriptor, or DOM mismatch disables the complete surface.
 */
export const planWikidotJoinActionBindings = (
  candidates: HTMLElement[],
  actions: MembershipBrowserAction[]
): [HTMLElement, MembershipBrowserAction][] => {
  if (
    candidates.length !== actions.length ||
    actions.some((action) => !validMembershipAction(action) || action.type !== "join") ||
    candidates.some((candidate) => !candidate.matches(JOIN_SELECTOR))
  ) {
    return []
  }
  return actions.map(
    (action, index) =>
      [candidates[index], action] as [HTMLElement, MembershipBrowserAction]
  )
}

const planTypedBindings = (
  candidates: HTMLElement[],
  actions: MembershipBrowserAction[],
  type: string
): [HTMLElement, MembershipBrowserAction][] => {
  const selector = selectorForAction(type)
  if (
    !selector ||
    candidates.length !== actions.length ||
    actions.some((action) => !validMembershipAction(action) || action.type !== type) ||
    candidates.some((candidate) => !candidate.matches(selector))
  ) {
    return []
  }
  return actions.map(
    (action, index) =>
      [candidates[index], action] as [HTMLElement, MembershipBrowserAction]
  )
}

/**
 * Execute a fixed membership action once and keep its visible busy state
 * until the server transition settles.
 */
export const performWikidotMembershipAction = async (
  element: HTMLElement,
  action: MembershipBrowserAction,
  runtime: MembershipActionRuntime
): Promise<boolean> => {
  if (busyActions.has(element) || !validMembershipAction(action)) return false

  const handler = runtime[action.type] as MembershipActionHandler | undefined
  if (!handler) return false

  busyActions.add(element)
  element.setAttribute("aria-busy", "true")
  try {
    let result: unknown
    if (action.type === "application") {
      const form = element.closest?.("#membership-by-apply-form")
      const comment =
        form?.querySelector?.<HTMLInputElement | HTMLTextAreaElement>('[name="comment"]')
          ?.value ?? ""
      result = await handler(
        action.page_id,
        action.revision_id,
        action.index,
        action.fingerprint,
        comment
      )
      if (result === "no_text") {
        runtime.error?.(new Error("You should write something in the box..."))
        return true
      }
    } else if (action.type === "password") {
      const form = element.closest?.("#membership-by-password-form")
      const password =
        form?.querySelector?.<HTMLInputElement>('[name="password"]')?.value ?? ""
      result = await handler(
        action.page_id,
        action.revision_id,
        action.index,
        action.fingerprint,
        password
      )
      if (result === "wrong_password") {
        const box = element.closest?.("#membership-by-password-box")
        const error = box?.querySelector?.<HTMLElement>("#mbp-error")
        if (error?.style) error.style.display = ""
        return true
      }
    } else if (action.type === "invitation") {
      result = await handler(
        action.page_id,
        action.revision_id,
        action.index,
        action.fingerprint
      )
      const outcome = result as
        { status?: string; site_name?: unknown; site_slug?: unknown } | null | undefined
      if (outcome?.status === "accepted") {
        const box = element.closest?.("#membership-email-invitation-box")
        if (box) {
          box.innerHTML = membershipEmailInvitationCongratulationsHtml(
            outcome.site_name,
            outcome.site_slug
          )
        }
        return true
      }
      if (outcome?.status === "already_member") {
        runtime.error?.(
          new Error(
            "It seems you already are a member of this site! Congratulations anyway ;-)"
          )
        )
        return true
      }
      if (outcome?.status === "unavailable") {
        runtime.error?.(new Error("Sorry, no invitation can be found."))
        return true
      }
    } else {
      result = await handler(
        action.page_id,
        action.revision_id,
        action.index,
        action.fingerprint
      )
    }
    runtime.reload?.(result)
    return true
  } catch (error) {
    runtime.error?.(error)
    return false
  } finally {
    busyActions.delete(element)
    element.removeAttribute("aria-busy")
  }
}

/**
 * Install capture-phase behavior so the trusted legacy `onclick` remains
 * in served DOM for parity but is never evaluated by the browser.
 */
export const wikidotMembershipActions = (
  root: HTMLElement,
  parameters: {
    actions: MembershipBrowserAction[]
    runtime: MembershipActionRuntime
  }
) => {
  const elements: Set<HTMLElement> = new Set()
  let runtime = parameters.runtime

  const refresh = (actions: MembershipBrowserAction[]) => {
    for (const element of elements) boundActions.delete(element)
    elements.clear()
    for (const type of ["join", "application", "password", "invitation"]) {
      const typedActions = actions.filter((action) => action?.type === type)
      if (typedActions.length === 0) continue
      const selector = selectorForAction(type)
      if (!selector) continue
      const candidates = [...root.querySelectorAll(selector)] as HTMLElement[]
      for (const element of candidates) elements.add(element)
      const bindings =
        type === "join"
          ? planWikidotJoinActionBindings(candidates, typedActions)
          : planTypedBindings(candidates, typedActions, type)
      for (const [element, action] of bindings) {
        boundActions.set(element, action)
      }
    }
  }
  refresh(parameters.actions)

  const actionElement = (event: Event) => {
    let element = event.target as HTMLElement | null
    while (element && element !== root) {
      if (elements.has(element)) return element
      element = element.parentElement
    }
    return undefined
  }
  const activate = (event: Event) => {
    const element = actionElement(event)
    if (!element) return
    const action = boundActions.get(element)
    event.preventDefault()
    event.stopPropagation()
    if (!action) return
    void performWikidotMembershipAction(element, action, runtime)
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.key === " " || event.key === "Enter") activate(event)
  }

  root.addEventListener("click", activate, true)
  root.addEventListener("keydown", keydown, true)
  return {
    destroy() {
      for (const element of elements) boundActions.delete(element)
      root.removeEventListener("click", activate, true)
      root.removeEventListener("keydown", keydown, true)
    },
    update(next: {
      actions: MembershipBrowserAction[]
      runtime: MembershipActionRuntime
    }) {
      runtime = next.runtime
      refresh(next.actions)
    }
  }
}
