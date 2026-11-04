export type EditLeaseMode = "page" | "append" | "section"

export type EditLeaseConflict = {
  userId: number
  mode: EditLeaseMode
  sectionIndex: number | null
  secondsRemaining: number
}

export type EditLeaseCredentials = {
  lockId: number
  lockSecret: string
  mode: EditLeaseMode
  sectionIndex: number | undefined
}

export type EditLeaseTransport = {
  acquire: (request: {
    force: boolean
    mode: EditLeaseMode
    sectionIndex: number | undefined
  }) => Promise<unknown>
  renew: (credentials: EditLeaseCredentials) => Promise<unknown>
  release: (credentials: EditLeaseCredentials) => Promise<unknown>
}

export type EditLeaseStatus =
  "idle" | "acquiring" | "held" | "conflict" | "superseded" | "released" | "closed"

export const EDIT_LEASE_PAGE_CHANGED_CODE = 4303
export const EDIT_LEASE_OTHER_LOCKS_CODE = 4304

export const classifyEditLeaseSaveError = (
  code: unknown
): "page_changed" | "other_locks" | null =>
  code === EDIT_LEASE_PAGE_CHANGED_CODE
    ? "page_changed"
    : code === EDIT_LEASE_OTHER_LOCKS_CODE
      ? "other_locks"
      : null

const errorCode = (error: unknown): unknown =>
  error !== null && typeof error === "object" && "code" in error
    ? (error as { code: unknown }).code
    : undefined

const normalizeConflicts = (conflicts: unknown): EditLeaseConflict[] =>
  Array.isArray(conflicts)
    ? conflicts.map((conflict) => ({
        userId: conflict.user_id,
        mode: conflict.mode,
        sectionIndex: conflict.section_index ?? null,
        secondsRemaining: conflict.seconds_remaining
      }))
    : []

export class WikidotEditLeaseSession {
  transport: EditLeaseTransport
  status: EditLeaseStatus = "idle"
  mode: EditLeaseMode = "page"
  sectionIndex: number | undefined = undefined
  lockId: number | undefined = undefined
  lockSecret: string | undefined = undefined
  baseRevisionId: number | null = null
  expiresAt: string | null = null
  conflicts: EditLeaseConflict[] = []
  conflictsAt = 0

  constructor(transport: EditLeaseTransport) {
    this.transport = transport
  }

  get held() {
    return this.lockId !== undefined && this.lockSecret !== undefined
  }

  credentials(): EditLeaseCredentials | undefined {
    if (!this.held) return undefined
    return {
      lockId: this.lockId as number,
      "lockSecret": this.lockSecret as string,
      mode: this.mode,
      sectionIndex: this.sectionIndex
    }
  }

  async open(mode: EditLeaseMode, sectionIndex: number | undefined) {
    this.mode = mode
    this.sectionIndex = sectionIndex
    return this.acquire(false)
  }

  async forceOpen() {
    return this.acquire(true)
  }

  async acquire(force: boolean) {
    this.status = "acquiring"
    const output = (await this.transport.acquire({
      force,
      mode: this.mode,
      sectionIndex: this.sectionIndex
    })) as { grant?: unknown; conflicts?: unknown }
    const grant = (output?.grant ?? null) as {
      lock_id: number
      lock_secret: string
      base_revision_id: number | null
      expires_at: string
    } | null
    if (grant) {
      this.lockId = grant.lock_id
      this.lockSecret = grant.lock_secret
      this.baseRevisionId = grant.base_revision_id ?? null
      this.expiresAt = grant.expires_at ?? null
      this.conflicts = []
      this.status = "held"
    } else {
      this.conflicts = normalizeConflicts(output?.conflicts)
      this.conflictsAt = Date.now()
      this.status = "conflict"
    }
    return this.status
  }

  async renew() {
    const credentials = this.credentials()
    if (!credentials) return false
    try {
      const output = (await this.transport.renew(credentials)) as {
        lock_id: number
        lock_secret: string
        base_revision_id: number | null
        expires_at: string
      }
      this.lockId = output.lock_id
      this.lockSecret = output.lock_secret
      this.baseRevisionId = output.base_revision_id ?? this.baseRevisionId
      this.expiresAt = output.expires_at ?? null
      this.status = "held"
      return true
    } catch (error) {
      if (errorCode(error) === EDIT_LEASE_OTHER_LOCKS_CODE) {
        this.status = "superseded"
      }
      return false
    }
  }

  saveFields() {
    const credentials = this.credentials()
    if (!credentials) return undefined
    return {
      ...credentials,
      lastRevisionId: this.baseRevisionId ?? 0
    }
  }

  noteSaveSucceeded(output: { revision_id?: unknown } | null | undefined) {
    this.status = "released"
    this.lockId = undefined
    this.lockSecret = undefined
    this.expiresAt = null
    if (output && typeof output.revision_id === "number") {
      this.baseRevisionId = output.revision_id
    }
  }

  noteSaveRejected(kind: "page_changed" | "other_locks" | null) {
    if (kind === "other_locks") {
      this.status = "superseded"
    }
  }

  async reopen() {
    this.lockId = undefined
    this.lockSecret = undefined
    return this.open(this.mode, this.sectionIndex)
  }

  async afterSave(
    output: { revision_id?: unknown } | null | undefined,
    staysOpen: boolean
  ) {
    this.noteSaveSucceeded(output)
    if (staysOpen) {
      return this.reopen()
    }
    return this.status
  }

  async close() {
    const credentials = this.credentials()
    const wasActive = this.status === "held" || this.status === "superseded"
    this.lockId = undefined
    this.lockSecret = undefined
    this.status = "closed"
    if (credentials && wasActive) {
      try {
        await this.transport.release(credentials)
      } catch {
        return
      }
    }
  }

  secondsRemaining(now: number = Date.now()) {
    if (this.status === "conflict" && this.conflicts.length > 0) {
      const elapsed = (now - this.conflictsAt) / 1000
      return Math.max(
        0,
        Math.min(
          ...this.conflicts.map((conflict) =>
            Math.ceil(conflict.secondsRemaining - elapsed)
          )
        )
      )
    }
    if (this.expiresAt) {
      return Math.max(0, Math.round((Date.parse(this.expiresAt) - now) / 1000))
    }
    return 0
  }

  conflictRows(now: number = Date.now()): EditLeaseConflict[] {
    const elapsed = (now - this.conflictsAt) / 1000
    return this.conflicts.map((conflict) => ({
      ...conflict,
      secondsRemaining: Math.max(0, Math.ceil(conflict.secondsRemaining - elapsed))
    }))
  }
}

export const createEditLeaseTransport = (
  post: (action: string, payload: Record<string, unknown>) => Promise<unknown>
): EditLeaseTransport => ({
  acquire: ({ force, mode, sectionIndex }) =>
    post(force ? "editLockForceAcquire" : "editLockAcquire", {
      mode,
      sectionIndex: sectionIndex ?? null
    }),
  renew: (credentials) =>
    post("editLockRenew", {
      lockId: credentials.lockId,
      "lockSecret": credentials.lockSecret,
      mode: credentials.mode,
      sectionIndex: credentials.sectionIndex ?? null
    }),
  release: (credentials) =>
    post("editLockRelease", {
      lockId: credentials.lockId,
      "lockSecret": credentials.lockSecret
    })
})
