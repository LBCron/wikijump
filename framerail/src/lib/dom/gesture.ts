import { scrollElement } from "./scrolling"

export type Point = [x: number, y: number]
export type Direction = "up" | "down" | "left" | "right"
export type Axis = "vertical" | "horizontal"
export type GestureType = "start" | "move" | "end" | "cancel"

export class Gesture {
  declare start: Point

  declare end: Point

  declare diff: Point

  declare diffAbs: Point

  declare direction: Direction

  declare dist: number

  declare type: GestureType

  constructor(start: Point, end: Point, type: GestureType = "move") {
    const x1 = start[0],
      y1 = start[1],
      x2 = end[0],
      y2 = end[1]

    const diff: Point = [y1 - y2, x1 - x2]
    const diffAbs: Point = [Math.abs(diff[0]), Math.abs(diff[1])]
    const axis = diffAbs[1] > diffAbs[0] ? 1 : 0
    const dist = diffAbs[axis]

    const direction = Gesture.directionFrom(axis, diff[axis])

    this.start = start
    this.end = end
    this.diff = diff
    this.diffAbs = diffAbs
    this.direction = direction
    this.dist = dist
    this.type = type
  }

  static directionFrom(axis: 0 | 1, delta: number): Direction {
    if (axis === 0) return delta < 0 ? "down" : "up"
    return delta < 0 ? "right" : "left"
  }

  get angle() {
    const x1 = this.start[0],
      y1 = this.start[1],
      x2 = this.end[0],
      y2 = this.end[1]
    return (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI
  }

  get axis(): Axis {
    return this.direction === "up" || this.direction === "down"
      ? "vertical"
      : "horizontal"
  }

  get sign(): -1 | 1 {
    return this.direction === "up" || this.direction === "left" ? -1 : 1
  }

  get isVertical(): boolean {
    return this.direction === "up" || this.direction === "down"
  }

  get isHorizontal(): boolean {
    return this.direction === "left" || this.direction === "right"
  }

  same(other: Direction | Direction[]) {
    return typeof other === "string"
      ? other === this.direction
      : other.includes(this.direction)
  }

  over(threshold?: number) {
    if (threshold === undefined) return false
    return this.dist > threshold
  }

  is(...types: GestureType[]) {
    return types.includes(this.type)
  }

  replace({ start, end, type }: { start?: Point; end?: Point; type?: GestureType }) {
    return new Gesture(start || this.start, end || this.end, type || this.type)
  }

  offset(clamp?: { min?: number; max?: number }) {
    let offset = this.sign * this.dist
    if (!clamp) return offset
    if (clamp.min !== undefined) offset = Math.max(offset, clamp.min)
    if (clamp.max !== undefined) offset = Math.min(offset, clamp.max)
    return offset
  }
}

export class GestureObserver {
  id: number | null = null

  start: Point | null = null

  constructor(
    public target: HTMLElement,
    public callback: (gesture: Gesture) => void
  ) {
    target.addEventListener("touchstart", this.handler, { passive: true })
  }

  private findTouch(evt: TouchEvent) {
    for (const touch of Array.from(evt.changedTouches)) {
      if (touch.identifier === this.id) return touch
    }
    return null
  }

  private cancel() {
    document.removeEventListener("touchmove", this.handler)
    document.removeEventListener("touchend", this.handler)
    document.removeEventListener("touchcancel", this.handler)
    this.id = null
    this.start = null
  }

  private handler = (evt: TouchEvent) => {
    let touch: Touch

    if (evt.type === "touchstart") {
      document.addEventListener("touchmove", this.handler, { passive: true })
      document.addEventListener("touchend", this.handler, { passive: true })
      document.addEventListener("touchcancel", this.handler, { passive: true })
      touch = evt.changedTouches[0]
      this.id = touch.identifier
      this.start = [touch.clientX, touch.clientY]
    } else if (this.id !== null) {
      const found = this.findTouch(evt)
      if (!found) return
      touch = found
    } else return

    let type: GestureType
    switch (evt.type) {
      case "touchstart":
        type = "start"
        break
      case "touchmove":
        type = "move"
        break
      case "touchend":
        type = "end"
        break
      case "touchcancel":
        type = "cancel"
        break
      default:
        throw new Error(`Unknown event type: ${evt.type}`)
    }

    const gesture = new Gesture(this.start!, [touch.clientX, touch.clientY], type)

    if (type !== "start") {
      const target = evt.target as HTMLElement
      if (scrollElement(target, gesture.axis)) this.cancel()
    }

    this.callback(gesture)

    if (gesture.is("end", "cancel")) this.cancel()
  }

  destroy() {
    this.target.removeEventListener("touchstart", this.handler)
  }
}
