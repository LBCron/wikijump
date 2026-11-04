import {
  attachRedisCommandSocket,
  createRedisCommandState,
  resetRedisCommandState,
  writeRedisCommand
} from "./redis-command-state.ts"
import type { RedisCommandState } from "./redis-command-state.ts"
import { connectRedisSocket } from "./redis-connection.ts"
import { RedisFenceInvalidationSubscriber } from "./redis-subscriber.ts"
import type { SubscriptionCallbacks } from "./redis-subscriber.ts"

const REDIS_COMMAND_TIMEOUT_MS = 1000

class RedisCacheStore {
  redisUrl: string
  commandState: RedisCommandState
  connecting: Promise<void> | null
  authCommands: (string | number)[][]

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl
    this.commandState = createRedisCommandState()
    this.connecting = null
    this.authCommands = this.buildAuthCommands(redisUrl)
  }

  get socket() {
    return this.commandState.socket
  }

  get pending() {
    return this.commandState.pending
  }

  buildAuthCommands(redisUrl: string): (string | number)[][] {
    const url = new URL(redisUrl)
    const commands: (string | number)[][] = []
    const password = decodeURIComponent(url.password)
    if (password) {
      const username = decodeURIComponent(url.username)
      commands.push(username ? ["AUTH", username, password] : ["AUTH", password])
    }

    const database = url.pathname.replace(/^\//, "")
    if (database) commands.push(["SELECT", database])
    return commands
  }

  async connect() {
    if (this.connecting) {
      await this.connecting
      return
    }
    const currentSocket = this.commandState.socket
    if (currentSocket && !currentSocket.destroyed) return

    this.connecting = (async () => {
      const socket = await connectRedisSocket(this.redisUrl, "Redis connection timed out")
      attachRedisCommandSocket({
        state: this.commandState,
        socket,
        onData: (chunk) => this.handleData(chunk),
        onDisconnect: () => this.reset()
      })

      try {
        for (const command of this.authCommands) await this.writeCommand(command)
      } catch (error) {
        this.reset()
        throw error
      }
    })().finally(() => {
      this.connecting = null
    })

    await this.connecting
  }

  reset() {
    resetRedisCommandState(this.commandState, "Redis connection closed")
  }

  handleData(chunk: Buffer) {
    const state = this.commandState
    state.decoder.append(chunk)

    while (state.pending.length > 0) {
      let parsed: { value: unknown } | null
      try {
        parsed = state.decoder.read()
      } catch (error) {
        const request = state.pending.shift()
        request?.reject(error instanceof Error ? error : new Error(String(error)))
        this.reset()
        return
      }
      if (!parsed) return

      state.pending.shift()?.resolve(parsed.value)
    }
  }

  async command(parts: (string | number)[]): Promise<unknown> {
    await this.connect()
    return this.writeCommand(parts)
  }

  writeCommand(parts: (string | number)[]): Promise<unknown> {
    return writeRedisCommand({
      state: this.commandState,
      parts,
      timeoutMs: REDIS_COMMAND_TIMEOUT_MS,
      unavailableMessage: "Redis connection unavailable",
      timeoutMessage: "Redis command timed out",
      onTimeout: () => this.reset()
    })
  }

  async get(key: string) {
    return this.command(["GET", key])
  }

  async mget(keys: string[]) {
    if (!Array.isArray(keys) || keys.length === 0) return []
    const values = await this.command(["MGET", ...keys])
    return Array.isArray(values) ? values : []
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    if (Number.isInteger(ttlSeconds) && Number(ttlSeconds) > 0) {
      await this.command(["SETEX", key, Number(ttlSeconds), value])
    } else {
      await this.command(["SET", key, value])
    }
    return true
  }

  subscribe(callbacks: SubscriptionCallbacks) {
    const subscriber = new RedisFenceInvalidationSubscriber(
      this.redisUrl,
      this.authCommands
    )
    subscriber.subscribe(callbacks)
    return subscriber
  }
}

export const createRedisCacheStore = (
  redisUrl: string | undefined = process.env.REDIS_URL
) => {
  if (!redisUrl) return null
  try {
    const url = new URL(redisUrl)
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") return null
    return new RedisCacheStore(redisUrl)
  } catch {
    return null
  }
}
