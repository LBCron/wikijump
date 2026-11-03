/** @typedef {"page" | "append" | "section"} EditLeaseMode */

/**
 * @typedef {object} EditLeaseConflict
 * @property {number} userId
 * @property {EditLeaseMode} mode
 * @property {number | null} sectionIndex
 * @property {number} secondsRemaining
 */

/**
 * @typedef {object} EditLeaseCredentials
 * @property {number} lockId
 * @property {string} lockSecret
 * @property {EditLeaseMode} mode
 * @property {number | undefined} sectionIndex
 */

/**
 * @typedef {object} EditLeaseTransport
 * @property {(request: {
 *   force: boolean
 *   mode: EditLeaseMode
 *   sectionIndex: number | undefined
 * }) => Promise<unknown>} acquire
 * @property {(credentials: EditLeaseCredentials) => Promise<unknown>} renew
 * @property {(credentials: EditLeaseCredentials) => Promise<unknown>} release
 */

export const EDIT_LEASE_PAGE_CHANGED_CODE = 4303
export const EDIT_LEASE_OTHER_LOCKS_CODE = 4304

/**
 * @param {unknown} code
 * @returns {"page_changed" | "other_locks" | null}
 */
export const classifyEditLeaseSaveError = (code) =>
  code === EDIT_LEASE_PAGE_CHANGED_CODE
    ? "page_changed"
    : code === EDIT_LEASE_OTHER_LOCKS_CODE
      ? "other_locks"
      : null

const errorCode = (error) =>
  error !== null && typeof error === "object" && "code" in error
    ? /** @type {{ code: unknown }} */ (error).code
    : undefined

const normalizeConflicts = (conflicts) =>
  Array.isArray(conflicts)
    ? conflicts.map((conflict) => ({
        userId: conflict.user_id,
        mode: conflict.mode,
        sectionIndex: conflict.section_index ?? null,
        secondsRemaining: conflict.seconds_remaining
      }))
    : []

export class WikidotEditLeaseSession {
  /** @type {EditLeaseTransport} */
  transport
  status = "idle"
  /** @type {EditLeaseMode} */
  mode = "page"
  /** @type {number | undefined} */
  sectionIndex = undefined
  /** @type {number | undefined} */
  lockId = undefined
  /** @type {string | undefined} */
  lockSecret = undefined
  /** @type {number | null} */
  baseRevisionId = null
  /** @type {string | null} */
  expiresAt = null
  /** @type {EditLeaseConflict[]} */
  conflicts = []
  conflictsAt = 0

  /** @param {EditLeaseTransport} transport */
  constructor(transport) {
    this.transport = transport
  }

  get held() {
    return this.lockId !== undefined && this.lockSecret !== undefined
  }

  /** @returns {EditLeaseCredentials | undefined} */
  credentials() {
    if (!this.held) return undefined
    return {
      lockId: /** @type {number} */ (this.lockId),
      ["lockSecret"]: /** @type {string} */ (this.lockSecret),
      mode: this.mode,
      sectionIndex: this.sectionIndex
    }
  }

  /**
   * @param {EditLeaseMode} mode
   * @param {number | undefined} sectionIndex
   */
  async open(mode, sectionIndex) {
    this.mode = mode
    this.sectionIndex = sectionIndex
    return this.acquire(false)
  }

  async forceOpen() {
    return this.acquire(true)
  }

  /** @param {boolean} force */
  async acquire(force) {
    this.status = "acquiring"
    const output = /** @type {{ grant?: unknown; conflicts?: unknown }} */ (
      await this.transport.acquire({
        force,
        mode: this.mode,
        sectionIndex: this.sectionIndex
      })
    )
    const grant =
      /**
       * @type {{
       *   lock_id: number
       *   lock_secret: string
       *   base_revision_id: number | null
       *   expires_at: string
       * } | null}
       */ (output?.grant ?? null)
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
      const output =
        /**
         * @type {{
         *   lock_id: number
         *   lock_secret: string
         *   base_revision_id: number | null
         *   expires_at: string
         * }}
         */ (await this.transport.renew(credentials))
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

  /** @param {{ revision_id?: unknown } | null | undefined} output */
  noteSaveSucceeded(output) {
    this.status = "released"
    this.lockId = undefined
    this.lockSecret = undefined
    this.expiresAt = null
    if (output && typeof output.revision_id === "number") {
      this.baseRevisionId = output.revision_id
    }
  }

  /** @param {"page_changed" | "other_locks" | null} kind */
  noteSaveRejected(kind) {
    if (kind === "other_locks") {
      this.status = "superseded"
    }
  }

  async reopen() {
    this.lockId = undefined
    this.lockSecret = undefined
    return this.open(this.mode, this.sectionIndex)
  }

  /**
   * @param {{ revision_id?: unknown } | null | undefined} output
   * @param {boolean} staysOpen
   */
  async afterSave(output, staysOpen) {
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

  /** @param {number} [now] */
  secondsRemaining(now = Date.now()) {
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

  /**
   * @param {number} [now]
   * @returns {EditLeaseConflict[]}
   */
  conflictRows(now = Date.now()) {
    const elapsed = (now - this.conflictsAt) / 1000
    return this.conflicts.map((conflict) => ({
      ...conflict,
      secondsRemaining: Math.max(0, Math.ceil(conflict.secondsRemaining - elapsed))
    }))
  }
}

/**
 * @param {(
 *   action: string,
 *   payload: Record<string, unknown>
 * ) => Promise<unknown>} post
 * @returns {EditLeaseTransport}
 */
export const createEditLeaseTransport = (post) => ({
  acquire: ({ force, mode, sectionIndex }) =>
    post(force ? "editLockForceAcquire" : "editLockAcquire", {
      mode,
      sectionIndex: sectionIndex ?? null
    }),
  renew: (credentials) =>
    post("editLockRenew", {
      lockId: credentials.lockId,
      ["lockSecret"]: credentials.lockSecret,
      mode: credentials.mode,
      sectionIndex: credentials.sectionIndex ?? null
    }),
  release: (credentials) =>
    post("editLockRelease", {
      lockId: credentials.lockId,
      ["lockSecret"]: credentials.lockSecret
    })
})
