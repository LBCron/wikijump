import {
  attachRedisCommandSocket,
  createRedisCommandState,
  resetRedisCommandState,
  writeRedisCommand
} from "./redis-command-state.ts"
import type { RedisCommandState } from "./redis-command-state.ts"
import { connectRedisSocket } from "./redis-connection.ts"

const REDIS_COMMAND_TIMEOUT_MS = 1000
const REDIS_SUBSCRIBER_RETRY_DELAY_MS = 100

export type RedisValue = string | number | null | unknown[]

export interface SubscriptionCallbacks {
  channel: string
  onSubscribed?: () => void
  onMessage?: (message: string) => void
  onDisconnect?: () => void
  onMalformed?: () => void
}

export class RedisFenceInvalidationSubscriber {
  redisUrl: string
  authCommands: (string | number)[][]
  commandState: RedisCommandState
  started: boolean
  running: boolean
  retryTimer: NodeJS.Timeout | null
  stopped: boolean
  subscribed: boolean
  channel: string | null
  onSubscribed: (() => void) | null
  onMessage: ((message: string) => void) | null
  onDisconnect: (() => void) | null
  onMalformed: (() => void) | null

  constructor(redisUrl: string, authCommands: (string | number)[][]) {
    this.redisUrl = redisUrl
    this.authCommands = authCommands
    this.commandState = createRedisCommandState()
    this.started = false
    this.running = false
    this.retryTimer = null
    this.stopped = false
    this.subscribed = false
    this.channel = null
    this.onSubscribed = null
    this.onMessage = null
    this.onDisconnect = null
    this.onMalformed = null
  }

  subscribe(callbacks: SubscriptionCallbacks) {
    if (this.started) return
    const { channel, onSubscribed, onMessage, onDisconnect, onMalformed } = callbacks
    this.started = true
    this.stopped = false
    this.channel = channel
    this.onSubscribed = onSubscribed ?? null
    this.onMessage = onMessage ?? null
    this.onDisconnect = onDisconnect ?? null
    this.onMalformed = onMalformed ?? null
    void this.run()
  }

  async run() {
    if (this.running || this.stopped) return
    this.running = true
    try {
      await this.connect()
      for (const command of this.authCommands) await this.command(command)
      const channel = this.channel
      if (!channel) {
        this.reset()
        return
      }
      const response = await this.command(["SUBSCRIBE", channel])
      if (
        !Array.isArray(response) ||
        response[0] !== "subscribe" ||
        response[1] !== channel
      ) {
        this.onMalformed?.()
        this.reset()
        return
      }
      this.subscribed = true
      this.onSubscribed?.()
    } catch {
      this.reset()
    } finally {
      this.running = false
      this.scheduleRetry()
    }
  }

  scheduleRetry() {
    if (this.stopped || !this.started || this.subscribed || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.run()
    }, REDIS_SUBSCRIBER_RETRY_DELAY_MS)
    this.retryTimer.unref?.()
  }

  async connect() {
    const currentSocket = this.commandState.socket
    if (currentSocket && !currentSocket.destroyed) return

    const socket = await connectRedisSocket(
      this.redisUrl,
      "Redis subscriber connection timed out"
    )
    attachRedisCommandSocket({
      state: this.commandState,
      socket,
      onData: (chunk) => this.handleData(chunk),
      onDisconnect: () => this.reset()
    })
  }

  reset() {
    this.subscribed = false
    resetRedisCommandState(this.commandState, "Redis subscriber connection closed")
    this.onDisconnect?.()
    this.scheduleRetry()
  }

  close() {
    this.stopped = true
    this.started = false
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.reset()
  }

  handleData(chunk: Buffer) {
    const state = this.commandState
    state.decoder.append(chunk)

    while (true) {
      let parsed: { value: RedisValue } | null
      try {
        parsed = state.decoder.read()
      } catch (error) {
        state.pending
          .shift()
          ?.reject(error instanceof Error ? error : new Error(String(error)))
        this.onMalformed?.()
        this.reset()
        return
      }
      if (!parsed) return

      const request = state.pending.shift()
      if (request) request.resolve(parsed.value)
      else this.handlePubSubMessage(parsed.value)
    }
  }

  handlePubSubMessage(value: RedisValue) {
    if (
      Array.isArray(value) &&
      value[0] === "message" &&
      value[1] === this.channel &&
      typeof value[2] === "string"
    ) {
      this.onMessage?.(value[2] as string)
      return
    }
    this.onMalformed?.()
  }

  async command(parts: (string | number)[]): Promise<unknown> {
    await this.connect()
    return writeRedisCommand({
      state: this.commandState,
      parts,
      timeoutMs: REDIS_COMMAND_TIMEOUT_MS,
      unavailableMessage: "Redis subscriber connection unavailable",
      timeoutMessage: "Redis subscriber command timed out",
      onTimeout: () => this.reset()
    })
  }
}
