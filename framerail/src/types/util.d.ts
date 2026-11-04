declare global {
  type AnyFunction<R = unknown> = (...args: never[]) => R

  type PromiseValue<PromiseType, Otherwise = PromiseType> =
    PromiseType extends Promise<infer Value>
      ? { 0: PromiseValue<Value>; 1: Value }[PromiseType extends Promise<unknown> ? 0 : 1]
      : Otherwise

  type Primitive = string | number | bigint | boolean | symbol | null | undefined

  type PlainObject = Record<string, Primitive>

  type Promisable<T> = T | PromiseLike<T>

  type JSONObject = { [Key in string]?: JSONValue }

  type JSONArray = JSONValue[]

  type JSONValue = string | number | boolean | null | JSONObject | JSONArray

  type FilterFor<O extends object, T> = {
    [Property in keyof O as O[Property] extends T ? Property : never]: O[Property]
  }

  type FilterOut<O extends object, T> = {
    [Property in keyof O as O[Property] extends T ? never : Property]: O[Property]
  }

  type Arrayable<T> = T | T[]

  type Functionable<T, A extends unknown[] = [], G = this> =
    T | ((this: G, ...args: A) => T)

  type Constructor<T = object, A extends unknown[] | void = void> = A extends unknown[]
    ? new (...args: A) => T
    : new () => T

  type AbstractClass<T = object, A extends unknown[] | void = void> = A extends unknown[]
    ? abstract new (...args: A) => T
    : abstract new () => T

  type Methods<T> = FilterFor<T, AnyFunction>
}

export {}
