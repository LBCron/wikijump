export interface ExpiryEntry {
  key: string
  expiresAt: number
  heapIndex: number
}

const neverExpires = (entry: ExpiryEntry) => Number.isNaN(entry.expiresAt)

export class ExpiryHeap {
  entries: ExpiryEntry[] = []

  first() {
    return this.entries[0]
  }

  swap(left: number, right: number) {
    const entries = this.entries
    ;[entries[left], entries[right]] = [entries[right], entries[left]]
    entries[left].heapIndex = left
    entries[right].heapIndex = right
  }

  up(index: number) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (!(this.entries[index].expiresAt < this.entries[parent].expiresAt)) break
      this.swap(index, parent)
      index = parent
    }
  }

  down(index: number) {
    for (;;) {
      const left = index * 2 + 1
      if (left >= this.entries.length) return
      const right = left + 1
      const child =
        right < this.entries.length &&
        this.entries[right].expiresAt < this.entries[left].expiresAt
          ? right
          : left
      if (!(this.entries[child].expiresAt < this.entries[index].expiresAt)) return
      this.swap(child, index)
      index = child
    }
  }

  insert(entry: ExpiryEntry) {
    if (neverExpires(entry)) return
    entry.heapIndex = this.entries.length
    this.entries.push(entry)
    this.up(entry.heapIndex)
  }

  remove(entry: ExpiryEntry) {
    const index = entry.heapIndex
    if (index < 0) return
    const last = this.entries.pop()
    entry.heapIndex = -1
    if (!last || last === entry) return
    this.entries[index] = last
    last.heapIndex = index
    const parent = Math.floor((index - 1) / 2)
    if (index > 0 && last.expiresAt < this.entries[parent].expiresAt) this.up(index)
    else this.down(index)
  }

  clear() {
    this.entries = []
  }
}
