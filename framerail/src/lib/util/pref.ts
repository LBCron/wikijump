import { writable, type Updater, type Writable } from "svelte/store"

export class PreferenceHandler {
  /**
   * @param prefix - The namespace to use for the preference handler.
   *   Defaults to `"_user-pref_"`
   */
  constructor(private prefix = "_user-pref_") {}

  private processName(name: string) {
    if (name.startsWith(this.prefix)) return name
    return this.prefix + name
  }

  /**
   * Attempt to retrieve the preference with the given name. If it isn't
   * found, the fallback value will instead be returned.
   *
   * @param name - The name/key for the preference.
   * @param fallback - The default value to return if the preference
   *   doesn't exist.
   */
  get<T = JSONValue>(name: string, fallback: T): T
  get<T = JSONValue>(name: string, fallback?: T): T | undefined
  get<T = JSONValue>(name: string, fallback?: T): T | undefined {
    name = this.processName(name)
    const storedPreference = localStorage.getItem(name)
    if (storedPreference) return JSON.parse(storedPreference) as T
    else return fallback
  }

  /**
   * Sets the preference with the given name to the given value. Passing an
   * empty string will remove the preference from storage.
   *
   * The `value` given **must** be in such a format that it can be
   * stringified by `JSON.stringify`. Otherwise, data _will_ be lost.
   *
   * @param name - The name/key for the preference.
   * @param value - The value to set. An empty string removes the
   *   preference.
   */
  set<T = JSONValue>(name: string, value: T) {
    name = this.processName(name)
    if (!value) localStorage.removeItem(name)
    else localStorage.setItem(name, JSON.stringify(value))
    return value
  }

  /**
   * Removes a preference from storage.
   *
   * @param name - The name/key for the preference.
   */
  remove(name: string) {
    name = this.processName(name)
    localStorage.removeItem(name)
  }

  /**
   * Returns if the requested preference is available in storage.
   *
   * @param name - The name/key for the preference.
   */
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

  /**
   * Returns a writable observable store that maps to the given preference.
   * Works with deep accesses and writes.
   *
   * @example
   *   ;```svelte
   *   <script lang="ts">
   *     const settings = Pref.bind("user-settings", { foo: "bar" })
   *     let current = $settings.foo // "bar"
   *     $settings.foo = "foobar" // updates localStorage!
   *     current = $settings.foo // "foobar"
   *   </script>
   *   ```
   *
   * @param name - The name/key for the preference.
   * @param fallback - The default value to return if the preference
   *   doesn't exist.
   */
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
