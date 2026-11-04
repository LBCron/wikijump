import { writable, type Updater, type Writable } from "svelte/store"

export class PreferenceHandler {
  constructor(private prefix = "_user-pref_") {}

  private processName(name: string) {
    if (name.startsWith(this.prefix)) return name
    return this.prefix + name
  }

  get<T = JSONValue>(name: string, fallback: T): T
  get<T = JSONValue>(name: string, fallback?: T): T | undefined
  get<T = JSONValue>(name: string, fallback?: T): T | undefined {
    name = this.processName(name)
    const storedPreference = localStorage.getItem(name)
    if (storedPreference) return JSON.parse(storedPreference) as T
    else return fallback
  }

  set<T = JSONValue>(name: string, value: T) {
    name = this.processName(name)
    if (!value) localStorage.removeItem(name)
    else localStorage.setItem(name, JSON.stringify(value))
    return value
  }

  remove(name: string) {
    name = this.processName(name)
    localStorage.removeItem(name)
  }

  has(name: string) {
    name = this.processName(name)
    return Boolean(localStorage.getItem(name))
  }

  stored() {
    const len = localStorage.length
    const keys = new Set<string>()
    for (let idx = 0; idx < len; idx++) {
      const name = localStorage.key(idx)
      if (name?.startsWith(this.prefix)) {
        keys.add(name.substr(this.prefix.length))
      }
    }
    return [...keys]
  }

  bind<T = JSONValue>(name: string, fallback?: T): Writable<T> {
    const handlerGet = this.get.bind(this)
    const handlerSet = this.set.bind(this)
    const store = writable<T>(this.get(name, fallback ?? ({} as T)))
    return {
      subscribe: store.subscribe,
      set: (val: T) => {
        store.set(typeof val === "object" && !Array.isArray(val) ? { ...val } : val)
        handlerSet(name, val)
      },
      update(cur: Updater<T>) {
        cur.call(this, handlerGet(name, fallback ?? ({} as T)))
      }
    }
  }

  wrap<T extends JSONObject>(name: string, fallback: T): T {
    const wrapped = this.get(name, fallback)
    const handler: ProxyHandler<T> = {
      get: (target, prop) => {
        const val = Reflect.get(target, prop)
        return val !== null && typeof val === "object"
          ? new Proxy(val as unknown as T, handler)
          : val
      },
      set: (target, prop, val) => {
        Reflect.set(target, prop, val)
        this.set(name, wrapped)
        return true
      }
    }
    return new Proxy(wrapped, handler)
  }
}

export const Pref = new PreferenceHandler()
