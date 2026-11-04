import assert from "node:assert/strict"
import test from "node:test"

import { installJavascriptAnchorGuard } from "../src/lib/wikidot/wikidot-javascript-anchors.ts"

type FakeClickEvent = {
  target: unknown
  defaultPrevented: boolean
  preventDefault: () => void
}
const fakeRoot = () => {
  const listeners = new Set<EventListener>()
  return {
    addEventListener: (type: string, listener: EventListener) => {
      assert.equal(type, "click")
      listeners.add(listener)
    },
    removeEventListener: (type: string, listener: EventListener) => {
      assert.equal(type, "click")
      listeners.delete(listener)
    },
    dispatch(
      target: unknown,
      { defaultPrevented = false }: { defaultPrevented?: boolean } = {}
    ) {
      const event: FakeClickEvent = {
        target,
        defaultPrevented,
        preventDefault(this: FakeClickEvent) {
          this.defaultPrevented = true
        }
      }
      for (const listener of listeners) listener(event as unknown as Event)
      return event
    },
    get listenerCount() {
      return listeners.size
    }
  }
}

const elementFor = (matchingSelector: string) => ({
  closest: (selector: string) => (selector === matchingSelector ? {} : null)
})

test("click on a Wikidot javascript:; control cancels the URL navigation", () => {
  const root = fakeRoot()
  installJavascriptAnchorGuard(root)

  const event = root.dispatch(elementFor('a[href="javascript:;"]'))

  assert.equal(event.defaultPrevented, true)
})

test("ordinary links keep their default navigation", () => {
  const root = fakeRoot()
  installJavascriptAnchorGuard(root)

  const event = root.dispatch({ closest: () => null })

  assert.equal(event.defaultPrevented, false)
})

test("an event another handler already cancelled is not changed", () => {
  const root = fakeRoot()
  installJavascriptAnchorGuard(root)

  const event = root.dispatch(elementFor('a[href="javascript:;"]'), {
    defaultPrevented: true
  })

  assert.equal(event.defaultPrevented, true)
})

test("non-element click targets are ignored", () => {
  const root = fakeRoot()
  installJavascriptAnchorGuard(root)

  const event = root.dispatch({})

  assert.equal(event.defaultPrevented, false)
})

test("uninstall removes the click listener", () => {
  const root = fakeRoot()
  const uninstall = installJavascriptAnchorGuard(root)

  assert.equal(root.listenerCount, 1)
  uninstall()
  assert.equal(root.listenerCount, 0)
})
