import type { Socket } from "node:net"
import type { TLSSocket } from "node:tls"

import { RedisResponseDecoder } from "./redis-response-decoder.ts"
import { RedisRequestQueue } from "./redis-request-queue.ts"
import { encodeRedisCommand } from "./redis-protocol.ts"

export interface PendingRedisRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export interface RedisCommandState {
  socket: Socket | TLSSocket | null
  decoder: RedisResponseDecoder
  pending: RedisRequestQueue<PendingRedisRequest>
}

export const createRedisCommandState = (): RedisCommandState => ({
  socket: null,
  decoder: new RedisResponseDecoder(),
  pending: new RedisRequestQueue()
})

export const attachRedisCommandSocket = ({
  state,
  socket,
  onData,
  onDisconnect
}: {
  state: RedisCommandState
  socket: Socket | TLSSocket
  onData: (chunk: Buffer) => void
  onDisconnect: () => void
}) => {
  state.socket = socket
  state.decoder = new RedisResponseDecoder()
  socket.on("data", onData)
  const disconnectIfCurrent = () => {
    if (state.socket === socket) onDisconnect()
  }
  socket.on("error", disconnectIfCurrent)
  socket.on("close", disconnectIfCurrent)
}

export const resetRedisCommandState = (
  state: RedisCommandState,
  closedMessage: string
) => {
  const socket = state.socket
  state.socket = null
  state.decoder = new RedisResponseDecoder()
  const pending = state.pending
  state.pending = new RedisRequestQueue()
  if (socket && !socket.destroyed) socket.destroy()
  for (let request: PendingRedisRequest | undefined; (request = pending.shift());) {
    request.reject(new Error(closedMessage))
  }
}

export const writeRedisCommand = ({
  state,
  parts,
  timeoutMs,
  unavailableMessage,
  timeoutMessage,
  onTimeout
}: {
  state: RedisCommandState
  parts: (string | number)[]
  timeoutMs: number
  unavailableMessage: string
  timeoutMessage: string
  onTimeout: () => void
}): Promise<unknown> => {
  const socket = state.socket
  if (!socket || socket.destroyed) throw new Error(unavailableMessage)

  const queue = state.pending
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      queue.remove(pendingNode)
      reject(new Error(timeoutMessage))
      onTimeout()
    }, timeoutMs)
    const pendingRequest: PendingRedisRequest = {
      resolve: (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    }
    const pendingNode = queue.push(pendingRequest)
    socket.write(encodeRedisCommand(parts), "utf8", (error) => {
      if (!error) return
      queue.remove(pendingNode)
      pendingRequest.reject(error)
    })
  })
}
