const OBSERVER_CONFIG = {
  childList: true,
  subtree: true,
  attributes: true,
  characterData: true
}

export function observe(
  target: HTMLElement,
  callback: (changes: MutationRecord[]) => void
) {
  const observer = new MutationObserver(callback)
  observer.observe(target, OBSERVER_CONFIG)
  return observer
}

export function pauseObservation(
  target: HTMLElement & { observer: MutationObserver },
  _key: string,
  descriptor: PropertyDescriptor
) {
  const method = descriptor.value
  const async = method.constructor.name === "AsyncFunction"

  if (async) {
    let runCount = 0

    descriptor.value = async function (this: typeof target, ...args: unknown[]) {
      this.observer.disconnect()
      runCount++
      const result = await method.apply(this, args)
      runCount--
      if (!runCount) this.observer.observe(this, OBSERVER_CONFIG)
      return result
    }
  } else {
    descriptor.value = function (this: typeof target, ...args: unknown[]) {
      this.observer.disconnect()
      const result = method.apply(this, args)
      this.observer.observe(this, OBSERVER_CONFIG)
      return result
    }
  }
}
