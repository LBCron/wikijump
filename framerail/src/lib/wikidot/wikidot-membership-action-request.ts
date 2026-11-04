type MembershipRequestRuntime = {
  fetch(input: string, init?: RequestInit): Promise<{ text(): Promise<string> }>
  deserialize(value: string): {
    type: string
    data?: { res?: unknown; message?: string }
  }
}

type MembershipActionInput = {
  pageId: number
  lastRevisionId: number
  actionIndex: number
  actionFingerprint: string
}

export const requestMembershipJoin = async (
  runtime: MembershipRequestRuntime,
  input: MembershipActionInput
) => {
  const response = await runtime.fetch("?/membershipJoin", {
    method: "POST",
    credentials: "same-origin",
    body: JSON.stringify({
      actionFingerprint: input.actionFingerprint,
      actionIndex: input.actionIndex,
      lastRevisionId: input.lastRevisionId,
      pageId: input.pageId
    })
  })
  const result = runtime.deserialize(await response.text())
  if (result.type === "failure") {
    throw new Error(result.data?.message ?? "Membership action failed.")
  }
  return result.data?.res
}

export const requestMembershipPassword = async (
  runtime: MembershipRequestRuntime,
  input: MembershipActionInput & { password: string }
) => {
  const response = await runtime.fetch("?/membershipPassword", {
    method: "POST",
    credentials: "same-origin",
    body: JSON.stringify({
      actionFingerprint: input.actionFingerprint,
      actionIndex: input.actionIndex,
      lastRevisionId: input.lastRevisionId,
      pageId: input.pageId,
      password: input.password
    })
  })
  const result = runtime.deserialize(await response.text())
  if (result.type === "failure") {
    throw new Error(result.data?.message ?? "Membership action failed.")
  }
  return result.data?.res
}

export const requestMembershipApplication = async (
  runtime: MembershipRequestRuntime,
  input: MembershipActionInput & { comment: string }
) => {
  const response = await runtime.fetch("?/membershipApplication", {
    method: "POST",
    credentials: "same-origin",
    body: JSON.stringify({
      actionFingerprint: input.actionFingerprint,
      actionIndex: input.actionIndex,
      comment: input.comment,
      lastRevisionId: input.lastRevisionId,
      pageId: input.pageId
    })
  })
  const result = runtime.deserialize(await response.text())
  if (result.type === "failure") {
    throw new Error(result.data?.message ?? "Membership action failed.")
  }
  return result.data?.res
}

export const requestMembershipEmailInvitation = async (
  runtime: MembershipRequestRuntime,
  input: MembershipActionInput
) => {
  const response = await runtime.fetch("?/membershipEmailInvitation", {
    method: "POST",
    credentials: "same-origin",
    body: JSON.stringify({
      actionFingerprint: input.actionFingerprint,
      actionIndex: input.actionIndex,
      lastRevisionId: input.lastRevisionId,
      pageId: input.pageId
    })
  })
  const result = runtime.deserialize(await response.text())
  if (result.type === "failure") {
    throw new Error(result.data?.message ?? "Membership action failed.")
  }
  return result.data?.res
}
