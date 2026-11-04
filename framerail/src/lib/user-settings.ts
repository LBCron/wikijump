import { limitLocalePreferences } from "./locales.ts"

export const parseUserLocalePreferences = (input: string): string[] => {
  return limitLocalePreferences(
    input.replaceAll("_", "-").replaceAll(",", " ").split(/\s+/u)
  )
}
