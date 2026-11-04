export interface RequestNode<T> {
  value: T
  previous: RequestNode<T> | null
  next: RequestNode<T> | null
  active: boolean
}

/**
 * FIFO with constant-time removal by handle. Unlike an array, draining or
 * cancelling a pipeline never moves/scans the other pending requests.
 */
export class RedisRequestQueue<T> {
  head: RequestNode<T> | null = null
  tail: RequestNode<T> | null = null
  length = 0

  push(value: T) {
    const node: RequestNode<T> = { value, previous: this.tail, next: null, active: true }
    if (this.tail) this.tail.next = node
    else this.head = node
    this.tail = node
    this.length += 1
    return node
  }

  remove(node: RequestNode<T>) {
    if (!node.active) return
    if (node.previous) node.previous.next = node.next
    else this.head = node.next
    if (node.next) node.next.previous = node.previous
    else this.tail = node.previous
    node.active = false
    node.previous = null
    node.next = null
    this.length -= 1
  }

  shift() {
    const node = this.head
    if (!node) return undefined
    this.remove(node)
    return node.value
  }
}
