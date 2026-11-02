/** @typedef {string | number | null | unknown[]} RedisValue */

export class RedisResponseDecoder {
  buffer = Buffer.alloc(0)
  used = 0
  offset = 0
  scan = 0
  /** @type {number | null} */
  bulkLength = null
  /** @type {{ length: number; values: RedisValue[] }[]} */
  arrays = []

  /** @param {Buffer} chunk */
  append(chunk) {
    if (this.offset === this.used) {
      this.buffer = Buffer.alloc(0)
      this.used = 0
      this.offset = 0
      this.scan = 0
    } else if (this.offset >= this.buffer.length / 2) {
      this.buffer.copyWithin(0, this.offset, this.used)
      this.used -= this.offset
      this.scan = Math.max(0, this.scan - this.offset)
      this.offset = 0
    }
    const required = this.used + chunk.length
    if (required > this.buffer.length) {
      const grown = Buffer.allocUnsafe(Math.max(required, this.buffer.length * 2, 256))
      this.buffer.copy(grown, 0, 0, this.used)
      this.buffer = grown
    }
    chunk.copy(this.buffer, this.used)
    this.used += chunk.length
  }

  /** @returns {{ value: RedisValue } | null} */
  read() {
    for (;;) {
      /** @type {RedisValue} */
      let value
      if (this.bulkLength !== null) {
        const end = this.offset + this.bulkLength
        if (this.used < end + 2) return null
        value = this.buffer.toString("utf8", this.offset, end)
        this.offset = end + 2
        this.bulkLength = null
      } else {
        if (this.offset >= this.used) return null
        const end = this.buffer
          .subarray(0, this.used)
          .indexOf("\r\n", Math.max(this.offset + 1, this.scan))
        if (end === -1) {
          this.scan = this.used - 1
          return null
        }
        const type = this.buffer[this.offset]
        const line = this.buffer.toString("utf8", this.offset + 1, end)
        this.offset = end + 2
        this.scan = this.offset
        if (type === 43) {
          value = line
        } // +
        else if (type === 45) {
          throw new Error(line)
        } // -
        else if (type === 58) {
          value = Number.parseInt(line, 10)
        } // :
        else if (type === 36 || type === 42) {
          // $ or *
          const length = Number.parseInt(line, 10)
          if (length === -1) value = null
          else {
            if (!Number.isInteger(length) || length < 0) {
              throw new Error(
                type === 36
                  ? "invalid Redis bulk string length"
                  : "invalid Redis array length"
              )
            }
            if (type === 36) {
              this.bulkLength = length
              continue
            }
            if (length > 0) {
              this.arrays.push({ length, values: [] })
              continue
            }
            value = []
          }
        } else throw new Error("unsupported Redis response type")
      }
      this.scan = this.offset
      for (;;) {
        const parent = this.arrays.at(-1)
        if (!parent) return { value }
        parent.values.push(value)
        if (parent.values.length < parent.length) break
        value = parent.values
        this.arrays.pop()
      }
    }
  }
}
