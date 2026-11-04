import type { TranslateKeys } from "$lib/types"

export interface TranslateRequest {
  locales: string[]
  messages: TranslateKeys
  strip_message_keys: string[]
  allow_missing: boolean
}

export function translateRequest(
  locales: string[],
  keys: TranslateKeys,
  stripKeys: string[]
): TranslateRequest {
  return {
    locales,
    messages: keys,
    strip_message_keys: stripKeys.filter((key) => Object.hasOwn(keys, key)),
    allow_missing: true
  }
}
